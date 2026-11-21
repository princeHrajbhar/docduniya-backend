import { OAuth2Client, type TokenPayload } from 'google-auth-library';
import type { Types } from 'mongoose';
import { env } from '../../../config/env.js';
import { logger } from '../../../config/logger.js';
import { AppError, ErrorCode } from '../../../utils/app-error.js';
import { EMAIL_DELIVERY_HINT, frontendUrl, isEmailSuppressed } from '../../email/index.js';
import {
  ACCOUNT_SETUP_TTL_MS,
  DEFAULT_USER_ROLE,
  LOGIN_LOCK_ATTEMPTS,
  LOGIN_LOCK_DURATION_MS,
} from './auth.constants.js';
import { hashPassword, verifyPassword } from './auth.crypto.js';
import {
  sendAccountSetupEmail,
  sendPasswordResetEmail,
  sendVerificationCodeEmail,
} from './auth.emails.js';
import type { AuthTokens, SessionMeta } from './auth.types.js';
import type {
  ChangePasswordInput,
  RegisterInput,
  ResetPasswordInput,
  VerifyOtpInput,
} from './auth.validation.js';
import { User, type UserDocument } from './models/user.model.js';
import * as otpService from './otp.service.js';
import { getRolePermissions } from './roles/role.service.js';
import * as sessionService from './session.service.js';

const googleClient = new OAuth2Client();

const GENERIC_RESEND_MESSAGE = `If applicable, a new verification code has been sent. ${EMAIL_DELIVERY_HINT}`;
const GENERIC_RESET_MESSAGE = `If that email is registered, a reset link has been sent. ${EMAIL_DELIVERY_HINT}`;

// ── Registration & email verification ───────────────────────────────────────

export async function register({ email, password }: RegisterInput) {
  if (await isEmailSuppressed(email)) {
    throw new AppError(
      'Email communication is disabled for this address. Contact support before registering.',
      403,
      ErrorCode.FORBIDDEN,
    );
  }

  const existing = await User.findOne({ email }).select('isVerified').lean();
  if (existing?.isVerified) throw new AppError('User already exists', 409, ErrorCode.USER_EXISTS);

  await otpService.assertNotInCooldown(email, 'EMAIL_VERIFICATION');

  // An unverified account may be re-registered: the password is replaced and a new code issued.
  await User.findOneAndUpdate(
    { email },
    { $set: { email, password: await hashPassword(password), isVerified: false } },
    { upsert: true, setDefaultsOnInsert: true },
  );

  await deliverVerificationCode(email);
  logger.info({ email }, 'Registration initiated; verification code sent');
  return { email };
}

export async function verifyEmail({ email, otp }: VerifyOtpInput) {
  await otpService.verifyVerificationCode(email, otp);

  const user = await User.findOneAndUpdate(
    { email },
    { $set: { isVerified: true } },
    { returnDocument: 'after' },
  );
  if (!user) throw new AppError('User not found', 404, ErrorCode.USER_NOT_FOUND);

  logger.info({ userId: user._id }, 'Email verified');
  return { id: user._id.toString(), email: user.email, isVerified: user.isVerified };
}

export async function resendCode(email: string, type: 'REGISTER' | 'RESET_PASSWORD') {
  if (type === 'RESET_PASSWORD') return forgotPassword(email);

  await otpService.assertNotInCooldown(email, 'EMAIL_VERIFICATION');
  const user = await User.findOne({ email }).select('isVerified').lean();
  // Same response whether or not the account exists, to prevent enumeration.
  if (!user || user.isVerified || (await isEmailSuppressed(email)))
    return { message: GENERIC_RESEND_MESSAGE };

  await deliverVerificationCode(email);
  logger.info({ email }, 'Verification code resent');
  return { message: GENERIC_RESEND_MESSAGE };
}

async function deliverVerificationCode(email: string): Promise<void> {
  const code = await otpService.issueVerificationCode(email);
  try {
    await sendVerificationCodeEmail(email, code);
  } catch (error) {
    // Withdraw the code so the cooldown does not block an immediate retry.
    await otpService.clearSecrets(email, ['EMAIL_VERIFICATION']);
    throw error;
  }
}

// ── Sign-in ─────────────────────────────────────────────────────────────────

export async function login(
  email: string,
  password: string,
  meta: SessionMeta,
): Promise<AuthTokens> {
  const user = await User.findOne({ email }).select('+password');

  if (user?.lockedUntil && user.lockedUntil > new Date()) {
    const retryMinutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
    throw new AppError(
      `Account temporarily locked. Try again in ${retryMinutes} minute(s).`,
      429,
      ErrorCode.ACCOUNT_LOCKED,
    );
  }

  // Always run a bcrypt comparison so timing does not reveal whether the account exists.
  const passwordMatches = await verifyPassword(password, user?.password);
  if (!user || !passwordMatches) {
    if (user) await recordFailedLogin(user);
    logger.warn({ email }, 'Failed login attempt');
    throw new AppError('Invalid credentials', 401, ErrorCode.INVALID_CREDENTIALS);
  }

  assertCanSignIn(user);
  return startSession(user, meta, 'User logged in');
}

export async function loginWithGoogle(credential: string, meta: SessionMeta): Promise<AuthTokens> {
  if (!env.GOOGLE_CLIENT_ID) {
    throw new AppError('Google sign-in is not configured', 503, ErrorCode.INTERNAL);
  }

  let payload: TokenPayload | undefined;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: env.GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch (error) {
    logger.warn({ err: error }, 'Google ID token verification failed');
    throw new AppError('Google sign-in could not be verified', 401, ErrorCode.INVALID_CREDENTIALS);
  }

  const googleSub = payload?.sub?.trim();
  const email = payload?.email?.trim().toLowerCase();
  if (!payload || !googleSub || !email || payload.email_verified !== true) {
    throw new AppError(
      'Google account must have a verified email',
      401,
      ErrorCode.INVALID_CREDENTIALS,
    );
  }

  let user = await User.findOne({ googleSub }).select('+googleSub');

  if (!user) {
    const existing = await User.findOne({ email }).select('+googleSub');
    if (existing) {
      if (existing.googleSub && existing.googleSub !== googleSub) {
        throw new AppError(
          'This email is already linked to another Google account',
          409,
          ErrorCode.USER_EXISTS,
        );
      }
      // Only link automatically when Google is authoritative for the address
      // (gmail.com or a Workspace domain); otherwise require password sign-in first.
      if (!isGoogleAuthoritativeForEmail(email, payload.hd)) {
        throw new AppError(
          'An account with this email already exists. Sign in with your password first.',
          409,
          ErrorCode.USER_EXISTS,
        );
      }
      existing.googleSub = googleSub;
      existing.isVerified = true;
      await existing.save();
      user = existing;
    } else {
      user = await User.create({ email, googleSub, isVerified: true, role: DEFAULT_USER_ROLE });
    }
  } else if (!user.isVerified) {
    user.isVerified = true;
    await user.save();
  }

  await otpService.clearSecrets(user.email, ['EMAIL_VERIFICATION']);
  assertCanSignIn(user);
  return startSession(user, meta, 'User logged in with Google');
}

function assertCanSignIn(user: Pick<UserDocument, 'isVerified' | 'isActive'>): void {
  if (!user.isVerified) {
    throw new AppError(
      'Please verify your account before logging in',
      403,
      ErrorCode.ACCOUNT_NOT_VERIFIED,
    );
  }
  if (!user.isActive) {
    throw new AppError(
      'This account has been disabled. Contact the administrator.',
      403,
      ErrorCode.ACCOUNT_DISABLED,
    );
  }
}

async function startSession(
  user: { _id: Types.ObjectId; role: string },
  meta: SessionMeta,
  logMessage: string,
): Promise<AuthTokens> {
  await User.updateOne(
    { _id: user._id },
    {
      $set: { failedLoginAttempts: 0, lastLoginAt: new Date() },
      $unset: { lockedUntil: 1, lastFailedLoginAt: 1 },
    },
  );
  const { sessionId, ...tokens } = await sessionService.createSession(user, meta);
  logger.info({ userId: user._id, sessionId }, logMessage);
  return tokens;
}

async function recordFailedLogin(user: UserDocument): Promise<void> {
  const now = new Date();
  const withinWindow =
    user.lastFailedLoginAt !== undefined &&
    now.getTime() - user.lastFailedLoginAt.getTime() <= LOGIN_LOCK_DURATION_MS;
  const attempts = (withinWindow ? user.failedLoginAttempts : 0) + 1;
  const shouldLock = attempts >= LOGIN_LOCK_ATTEMPTS;

  await User.updateOne(
    { _id: user._id },
    shouldLock
      ? {
          $set: {
            failedLoginAttempts: 0,
            lastFailedLoginAt: now,
            lockedUntil: new Date(now.getTime() + LOGIN_LOCK_DURATION_MS),
          },
        }
      : {
          $set: { failedLoginAttempts: attempts, lastFailedLoginAt: now },
          $unset: { lockedUntil: 1 },
        },
  );
  if (shouldLock) logger.warn({ userId: user._id }, 'Account locked after repeated failed logins');
}

function isGoogleAuthoritativeForEmail(email: string, hostedDomain?: string): boolean {
  return email.endsWith('@gmail.com') || Boolean(hostedDomain?.trim());
}

// ── Tokens & sessions ───────────────────────────────────────────────────────

export const refresh = (refreshToken: string) => sessionService.rotateSession(refreshToken);

export const logout = (refreshToken: string) => sessionService.revokeByRefreshToken(refreshToken);

export async function logoutAll(userId: string): Promise<void> {
  const revoked = await sessionService.revokeAllSessions(userId);
  logger.info({ userId, revoked }, 'All sessions terminated');
}

export const listSessions = (userId: string, currentSessionId: string) =>
  sessionService.listActiveSessions(userId, currentSessionId);

export async function revokeOwnSession(userId: string, sessionId: string): Promise<void> {
  if (!(await sessionService.revokeSession(userId, sessionId))) {
    throw new AppError('Session not found', 404, ErrorCode.SESSION_NOT_FOUND);
  }
}

// ── Password management ─────────────────────────────────────────────────────

export async function forgotPassword(email: string) {
  const user = await User.findOne({ email }).select('isVerified isActive').lean();
  if (!user?.isVerified || !user.isActive || (await isEmailSuppressed(email)))
    return { message: GENERIC_RESET_MESSAGE };
  if (await otpService.isInCooldown(email, 'PASSWORD_RESET'))
    return { message: GENERIC_RESET_MESSAGE };

  const token = await otpService.issuePasswordResetToken(email);
  try {
    await sendPasswordResetEmail(email, buildResetUrl(email, token));
  } catch (error) {
    await otpService.clearSecrets(email, ['PASSWORD_RESET']);
    throw error;
  }

  logger.info({ email }, 'Password reset link sent');
  return { message: GENERIC_RESET_MESSAGE };
}

export async function resetPassword(payload: ResetPasswordInput) {
  const { token, email, newPassword } = extractResetCredentials(payload);

  // Consume the token before changing the password so it cannot be reused concurrently.
  await otpService.consumePasswordResetToken(email, token);

  const user = await User.findOneAndUpdate(
    { email },
    {
      // Completing a reset (or admin account setup) proves control of the mailbox.
      $set: {
        password: await hashPassword(newPassword),
        isVerified: true,
        mustChangePassword: false,
        failedLoginAttempts: 0,
      },
      $unset: { lockedUntil: 1, lastFailedLoginAt: 1 },
    },
    { returnDocument: 'after' },
  );
  if (!user) throw new AppError('User not found', 404, ErrorCode.USER_NOT_FOUND);

  await sessionService.revokeAllSessions(user._id);
  logger.info({ userId: user._id }, 'Password reset; all sessions revoked');
  return { message: 'Password reset successful. Please log in again.' };
}

export async function changePassword(
  userId: string,
  sessionId: string,
  input: ChangePasswordInput,
) {
  const user = await User.findById(userId).select('+password');
  if (!user) throw new AppError('User not found', 404, ErrorCode.USER_NOT_FOUND);

  if (!(await verifyPassword(input.currentPassword, user.password))) {
    throw new AppError('Current password is incorrect', 401, ErrorCode.INVALID_CREDENTIALS);
  }

  await User.updateOne(
    { _id: userId },
    { $set: { password: await hashPassword(input.newPassword), mustChangePassword: false } },
  );
  await sessionService.revokeAllSessions(userId, { exceptSessionId: sessionId });

  logger.info({ userId }, 'Password changed; other sessions revoked');
  return { message: 'Password changed successfully.' };
}

/**
 * Issues a single-use password setup link for an admin-created account and
 * emails it. Returns whether the email was delivered.
 */
export async function sendAccountSetupLink(input: {
  email: string;
  role: string;
  actorUserId: string;
}) {
  const token = await otpService.issuePasswordResetToken(input.email, ACCOUNT_SETUP_TTL_MS);
  try {
    await sendAccountSetupEmail({
      to: input.email,
      role: input.role,
      setupUrl: buildResetUrl(input.email, token),
      actorUserId: input.actorUserId,
    });
    return true;
  } catch (error) {
    logger.error({ err: error, email: input.email }, 'Account setup email could not be sent');
    return false;
  }
}

function buildResetUrl(email: string, token: string): string {
  const url = new URL(frontendUrl('/reset-password'));
  url.searchParams.set('token', token);
  url.searchParams.set('email', email);
  return url.toString();
}

function extractResetCredentials(payload: ResetPasswordInput) {
  if ('token' in payload) return payload;

  let url: URL;
  try {
    url = new URL(payload.resetUrl);
  } catch {
    throw new AppError('Invalid reset link', 400, ErrorCode.BAD_REQUEST);
  }
  const token = url.searchParams.get('token')?.trim();
  const email = url.searchParams.get('email')?.trim().toLowerCase();
  if (!token || !email || !/^[a-f0-9]{64}$/i.test(token)) {
    throw new AppError('Invalid reset link', 400, ErrorCode.BAD_REQUEST);
  }
  return { token, email, newPassword: payload.newPassword };
}

// ── Current user ────────────────────────────────────────────────────────────

export async function getCurrentUser(userId: string) {
  const user = await User.findById(userId).lean();
  if (!user) throw new AppError('User not found', 404, ErrorCode.USER_NOT_FOUND);
  return {
    userId: user._id.toString(),
    email: user.email,
    role: user.role,
    isVerified: user.isVerified,
    mustChangePassword: user.mustChangePassword === true,
    permissions: await getRolePermissions(user.role),
  };
}
