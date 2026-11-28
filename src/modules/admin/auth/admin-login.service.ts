/**
 * Administrator portal sign-in. Platform staff (accounts whose role grants platform permissions)
 * sign in only here, never through the patient and doctor sign-in:
 *
 *   1. `startAdminSignIn`: password, then a six-digit code is emailed to the administrator.
 *   2. `completeAdminSignIn`: the code; then a session, or the authenticator step when the
 *      administrator has enrolled one (completed by `POST /auth/mfa/verify`).
 *
 * Every sign-in needs a fresh emailed code. Accounts without platform permissions get the same
 * answer as a wrong password, so the portal does not reveal which accounts are administrators.
 */
import { createHash } from 'node:crypto';
import { logger } from '../../../config/logger.js';
import { AppError, ErrorCode } from '../../../utils/app-error.js';
import { OTP_RESEND_COOLDOWN_MS } from './auth.constants.js';
import { generateOtp, generateSecureToken, hashOtp, verifyOtpHash } from './auth.crypto.js';
import { sendAdminSignInCodeEmail } from './auth.emails.js';
import {
  assertCanSignIn,
  authenticatePassword,
  isPlatformStaff,
  startSession,
} from './auth.service.js';
import type { AuthTokens, SessionMeta } from './auth.types.js';
import { beginSignIn, type MfaPending } from './mfa/mfa.service.js';
import { AdminSignInChallenge } from './models/admin-signin.model.js';
import { User } from './models/user.model.js';

export const ADMIN_CODE_TTL_MS = 10 * 60_000;
export const ADMIN_CODE_MAX_ATTEMPTS = 5;
/** Emails per challenge: the first code plus two resends. */
export const ADMIN_CODE_MAX_SENDS = 3;

/** Email delivery of the code; tests replace `send` so no real email leaves the process. */
export const adminCodeDelivery = { send: sendAdminSignInCodeEmail };

export interface AdminCodePending {
  verificationRequired: true;
  challengeToken: string;
  expiresAt: Date;
  /** The address the code went to, partly hidden (`ad***@example.com`). */
  sentTo: string;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const invalidCredentials = () =>
  new AppError('Invalid credentials', 401, ErrorCode.INVALID_CREDENTIALS);
const expired = () =>
  new AppError('This sign-in attempt has expired. Sign in again.', 401, ErrorCode.TOKEN_INVALID);

export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(3, local.length - visible.length))}@${domain}`;
}

const clip = (meta: SessionMeta) => ({
  ...(meta.userAgent ? { userAgent: meta.userAgent.slice(0, 512) } : {}),
  ...(meta.ip ? { ip: meta.ip.slice(0, 64) } : {}),
});

/** Step 1: password, then email a code. No session exists until the code is entered. */
export async function startAdminSignIn(
  email: string,
  password: string,
  meta: SessionMeta,
): Promise<AdminCodePending> {
  const user = await authenticatePassword(email, password);
  if (!(await isPlatformStaff(user.role))) {
    logger.warn({ userId: user._id }, 'Administrator portal sign-in by a non-administrator');
    throw invalidCredentials();
  }
  assertCanSignIn(user);

  const now = new Date();
  const recent = await AdminSignInChallenge.exists({
    userId: user._id,
    consumedAt: { $exists: false },
    lastSentAt: { $gt: new Date(now.getTime() - OTP_RESEND_COOLDOWN_MS) },
  });
  if (recent)
    throw new AppError(
      `A code was just sent. Wait ${Math.round(OTP_RESEND_COOLDOWN_MS / 1000)} seconds before signing in again.`,
      429,
      ErrorCode.OTP_COOLDOWN,
    );
  // Only the newest sign-in attempt can be completed.
  await AdminSignInChallenge.updateMany(
    { userId: user._id, consumedAt: { $exists: false } },
    { $set: { consumedAt: now, closedReason: 'SUPERSEDED' } },
  );

  const code = generateOtp();
  const challengeToken = generateSecureToken();
  const expiresAt = new Date(now.getTime() + ADMIN_CODE_TTL_MS);
  const challenge = await AdminSignInChallenge.create({
    userId: user._id,
    tokenHash: hashToken(challengeToken),
    codeHash: await hashOtp(code),
    expiresAt,
    lastSentAt: now,
    ...clip(meta),
  });
  try {
    await adminCodeDelivery.send(user.email, code, { expiresAt, ...clip(meta) });
  } catch (error) {
    // Without the email the challenge cannot be completed; remove it so a retry is not blocked.
    await AdminSignInChallenge.deleteOne({ _id: challenge._id });
    throw error;
  }
  logger.info({ userId: user._id }, 'Administrator sign-in code sent');
  return { verificationRequired: true, challengeToken, expiresAt, sentTo: maskEmail(user.email) };
}

/** Sends a new code for an open challenge. The previous code stops working. */
export async function resendAdminSignInCode(
  challengeToken: string,
  meta: SessionMeta,
): Promise<Omit<AdminCodePending, 'challengeToken'>> {
  const now = new Date();
  const open = await AdminSignInChallenge.findOne({
    tokenHash: hashToken(challengeToken),
    consumedAt: { $exists: false },
    expiresAt: { $gt: now },
  });
  if (!open) throw expired();
  if (open.sends >= ADMIN_CODE_MAX_SENDS)
    throw new AppError('Too many codes requested. Sign in again.', 429, ErrorCode.OTP_MAX_ATTEMPTS);
  const code = generateOtp();
  const expiresAt = new Date(now.getTime() + ADMIN_CODE_TTL_MS);
  // Conditional on the cooldown and send count, so concurrent resends send one email.
  const updated = await AdminSignInChallenge.findOneAndUpdate(
    {
      _id: open._id,
      consumedAt: { $exists: false },
      sends: { $lt: ADMIN_CODE_MAX_SENDS },
      lastSentAt: { $lte: new Date(now.getTime() - OTP_RESEND_COOLDOWN_MS) },
    },
    {
      $set: { codeHash: await hashOtp(code), expiresAt, lastSentAt: now, attempts: 0 },
      $inc: { sends: 1 },
    },
    { returnDocument: 'after' },
  );
  if (!updated)
    throw new AppError(
      `Please wait ${Math.round(OTP_RESEND_COOLDOWN_MS / 1000)} seconds before requesting a new code`,
      429,
      ErrorCode.OTP_COOLDOWN,
    );
  const user = await User.findById(updated.userId).select('email');
  if (!user) throw expired();
  await adminCodeDelivery.send(user.email, code, { expiresAt, ...clip(meta) });
  return { verificationRequired: true, expiresAt, sentTo: maskEmail(user.email) };
}

/** Step 2: the emailed code. Single use; five attempts per code. */
export async function completeAdminSignIn(
  input: { challengeToken: string; code: string },
  meta: SessionMeta,
): Promise<AuthTokens | MfaPending> {
  const challenge = await AdminSignInChallenge.findOneAndUpdate(
    {
      tokenHash: hashToken(input.challengeToken),
      consumedAt: { $exists: false },
      expiresAt: { $gt: new Date() },
      attempts: { $lt: ADMIN_CODE_MAX_ATTEMPTS },
    },
    { $inc: { attempts: 1 } },
    { returnDocument: 'after' },
  ).select('+codeHash');
  if (!challenge) throw expired();
  if (!(await verifyOtpHash(input.code, challenge.codeHash))) {
    logger.warn({ userId: challenge.userId }, 'Failed administrator sign-in code');
    const left = ADMIN_CODE_MAX_ATTEMPTS - challenge.attempts;
    throw new AppError(
      left > 0
        ? `That code is not right. ${left} attempt${left === 1 ? '' : 's'} left.`
        : 'Too many wrong codes. Sign in again.',
      401,
      left > 0 ? ErrorCode.OTP_INVALID : ErrorCode.OTP_MAX_ATTEMPTS,
    );
  }
  const consumed = await AdminSignInChallenge.updateOne(
    { _id: challenge._id, consumedAt: { $exists: false } },
    { $set: { consumedAt: new Date(), closedReason: 'VERIFIED' } },
  );
  if (consumed.modifiedCount !== 1) throw expired();

  // Re-check the account: it may have been disabled or demoted since the password step.
  const user = await User.findOne({ _id: challenge.userId });
  if (!user || !(await isPlatformStaff(user.role))) throw invalidCredentials();
  assertCanSignIn(user);
  return beginSignIn(user, meta, () => startSession(user, meta, 'Administrator signed in'));
}
