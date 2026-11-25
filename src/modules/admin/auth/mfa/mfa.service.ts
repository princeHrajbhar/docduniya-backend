import { createHash, randomBytes } from 'node:crypto';
import type { Types } from 'mongoose';
import { env } from '../../../../config/env.js';
import { logger } from '../../../../config/logger.js';
import { AppError, ErrorCode } from '../../../../utils/app-error.js';
import { ApiError } from '../../../../utils/api-error.js';
import { User } from '../models/user.model.js';
import * as sessionService from '../session.service.js';
import type { AuthTokens, SessionMeta } from '../auth.types.js';
import { MfaChallenge, MfaFactor } from './mfa.model.js';
import {
  hashCode,
  newSecret,
  openSecret,
  otpauthUri,
  recoveryCodes,
  sealSecret,
  verifyTotp,
  base32Encode,
} from './totp.js';

const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_CHALLENGE_ATTEMPTS = 5;
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export interface MfaPending {
  mfaRequired: true;
  challengeToken: string;
  expiresAt: Date;
}

/** Runtime policy; tests and operations can tighten it without a restart. */
export const mfaPolicy = { enforcePrivileged: env.MFA_ENFORCE_PRIVILEGED };

export async function hasActiveFactor(userId: string | Types.ObjectId): Promise<boolean> {
  return Boolean(await MfaFactor.exists({ userId, status: 'ACTIVE' }));
}

/**
 * Privileged administration (platform review, organization ownership/administration) needs an
 * enrolled factor when enforcement is on. Because sign-in always asks for an active factor,
 * enrollment means every current session of that user passed the second step.
 */
export async function requireMfaForPrivilege(userId: string): Promise<void> {
  if (!mfaPolicy.enforcePrivileged) return;
  if (!(await hasActiveFactor(userId)))
    throw new ApiError(
      403,
      'Enroll an authenticator app before using administrative functions',
      undefined,
      'MFA_ENROLLMENT_REQUIRED',
    );
}

/** Called after the first factor succeeds: either a session or a pending second step. */
export async function beginSignIn(
  user: { _id: Types.ObjectId; role: string },
  meta: SessionMeta,
  createSession: () => Promise<AuthTokens>,
): Promise<AuthTokens | MfaPending> {
  if (!(await hasActiveFactor(user._id))) return createSession();
  const challengeToken = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
  await MfaChallenge.create({
    userId: user._id,
    tokenHash: hashToken(challengeToken),
    expiresAt,
    ...(meta.userAgent ? { userAgent: meta.userAgent.slice(0, 512) } : {}),
    ...(meta.ip ? { ip: meta.ip.slice(0, 64) } : {}),
  });
  return { mfaRequired: true, challengeToken, expiresAt };
}

const invalidCode = () =>
  new AppError('The verification code is invalid', 401, ErrorCode.INVALID_CREDENTIALS);

/** Checks a TOTP or recovery code atomically: replayed steps and used recovery codes fail. */
async function consumeCode(
  userId: Types.ObjectId | string,
  input: { code?: string; recoveryCode?: string },
): Promise<boolean> {
  const factor = await MfaFactor.findOne({ userId, status: 'ACTIVE' }).select(
    '+sealedSecret +recoveryCodeHashes',
  );
  if (!factor) return false;
  if (input.code) {
    const step = verifyTotp(openSecret(factor.sealedSecret), input.code);
    if (step === undefined) return false;
    const result = await MfaFactor.updateOne(
      { _id: factor._id, lastUsedStep: { $lt: step } },
      { $set: { lastUsedStep: step, lastVerifiedAt: new Date() } },
    );
    return result.modifiedCount === 1;
  }
  if (input.recoveryCode) {
    const hash = hashCode(input.recoveryCode);
    const result = await MfaFactor.updateOne(
      { _id: factor._id, recoveryCodeHashes: hash },
      { $pull: { recoveryCodeHashes: hash }, $set: { lastVerifiedAt: new Date() } },
    );
    return result.modifiedCount === 1;
  }
  return false;
}

/** Second sign-in step. A challenge allows five attempts and is single use. */
export async function completeSignIn(
  input: { challengeToken: string; code?: string; recoveryCode?: string },
  meta: SessionMeta,
): Promise<AuthTokens> {
  const challenge = await MfaChallenge.findOneAndUpdate(
    {
      tokenHash: hashToken(input.challengeToken),
      consumedAt: { $exists: false },
      expiresAt: { $gt: new Date() },
      attempts: { $lt: MAX_CHALLENGE_ATTEMPTS },
    },
    { $inc: { attempts: 1 } },
    { returnDocument: 'after' },
  );
  if (!challenge)
    throw new AppError('The sign-in step has expired; sign in again', 401, ErrorCode.TOKEN_INVALID);
  if (!(await consumeCode(challenge.userId, input))) {
    logger.warn({ userId: challenge.userId }, 'Failed second-factor attempt');
    throw invalidCode();
  }
  const consumed = await MfaChallenge.updateOne(
    { _id: challenge._id, consumedAt: { $exists: false } },
    { $set: { consumedAt: new Date() } },
  );
  if (consumed.modifiedCount !== 1) throw invalidCode();
  const user = await User.findOne({ _id: challenge.userId, isActive: true, isVerified: true });
  if (!user) throw new AppError('Account is unavailable', 403, ErrorCode.ACCOUNT_DISABLED);
  await User.updateOne(
    { _id: user._id },
    { $set: { failedLoginAttempts: 0, lastLoginAt: new Date() } },
  );
  const { accessToken, refreshToken } = await sessionService.createSession(user, meta);
  return { accessToken, refreshToken };
}

/** Starts (or restarts) enrollment. The factor is inactive until a code proves possession. */
export async function startEnrollment(userId: string) {
  const user = await User.findById(userId).select('email');
  if (!user) throw ApiError.notFound();
  if (await hasActiveFactor(userId))
    throw new ApiError(
      409,
      'An authenticator is already active; disable it first',
      undefined,
      'CONFLICT',
    );
  const secret = newSecret();
  await MfaFactor.findOneAndUpdate(
    { userId },
    {
      $set: { sealedSecret: sealSecret(secret), status: 'PENDING', lastUsedStep: 0 },
      $setOnInsert: { kind: 'TOTP' },
    },
    { upsert: true },
  );
  return { secret: base32Encode(secret), otpauthUri: otpauthUri(secret, user.email) };
}

/**
 * Activation proves possession, issues recovery codes once and ends every other session, so
 * no session that skipped the second factor survives enrollment.
 */
export async function activateEnrollment(userId: string, code: string, currentSessionId?: string) {
  const factor = await MfaFactor.findOne({ userId, status: 'PENDING' }).select('+sealedSecret');
  if (!factor) throw ApiError.notFound('Start enrollment first');
  const step = verifyTotp(openSecret(factor.sealedSecret), code);
  if (step === undefined) throw invalidCode();
  const codes = recoveryCodes();
  const result = await MfaFactor.updateOne(
    { _id: factor._id, status: 'PENDING' },
    {
      $set: {
        status: 'ACTIVE',
        lastUsedStep: step,
        activatedAt: new Date(),
        recoveryCodeHashes: codes.map(hashCode),
      },
    },
  );
  if (result.modifiedCount !== 1)
    throw new ApiError(409, 'Enrollment changed', undefined, 'CONFLICT');
  await sessionService.revokeAllSessions(userId, { exceptSessionId: currentSessionId });
  logger.info({ userId }, 'Authenticator enrolled');
  return { activated: true, recoveryCodes: codes };
}

export async function regenerateRecoveryCodes(userId: string, code: string) {
  if (!(await consumeCode(userId, { code }))) throw invalidCode();
  const codes = recoveryCodes();
  await MfaFactor.updateOne(
    { userId, status: 'ACTIVE' },
    { $set: { recoveryCodeHashes: codes.map(hashCode) } },
  );
  return { recoveryCodes: codes };
}

/** Disabling needs a current code; privileged users under enforcement must keep a factor. */
export async function disableFactor(userId: string, code: string, privileged: boolean) {
  if (privileged && mfaPolicy.enforcePrivileged)
    throw ApiError.forbidden('Administrators must keep an authenticator enrolled');
  if (!(await consumeCode(userId, { code }))) throw invalidCode();
  await MfaFactor.deleteOne({ userId });
  logger.info({ userId }, 'Authenticator removed');
  return { disabled: true };
}

export async function mfaStatus(userId: string) {
  const factor = await MfaFactor.findOne({ userId }).select('+recoveryCodeHashes').lean();
  return {
    enrolled: factor?.status === 'ACTIVE',
    pending: factor?.status === 'PENDING',
    activatedAt: factor?.activatedAt,
    recoveryCodesRemaining: factor?.recoveryCodeHashes?.length ?? 0,
    enforcedForAdministrators: mfaPolicy.enforcePrivileged,
  };
}
