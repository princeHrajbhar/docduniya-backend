import { AppError, ErrorCode } from '../../../utils/app-error.js';
import {
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_MS,
  OTP_TTL_MS,
  PASSWORD_RESET_TTL_MS,
} from './auth.constants.js';
import {
  generateOtp,
  generateSecureToken,
  hashOtp,
  hashToken,
  safeEqual,
  verifyOtpHash,
} from './auth.crypto.js';
import { Otp, type OtpPurpose } from './models/otp.model.js';

/**
 * Central one-time-secret management. Plaintext codes/tokens are returned to the
 * caller exactly once (to be emailed) and only their hashes are persisted.
 * Issuing a new secret always invalidates the previous one for that purpose.
 */

/** True when a secret for this purpose was issued within the resend cooldown. */
export async function isInCooldown(email: string, purpose: OtpPurpose): Promise<boolean> {
  return Boolean(
    await Otp.exists({
      email,
      purpose,
      createdAt: { $gt: new Date(Date.now() - OTP_RESEND_COOLDOWN_MS) },
    }),
  );
}

export async function assertNotInCooldown(email: string, purpose: OtpPurpose): Promise<void> {
  if (await isInCooldown(email, purpose)) {
    throw new AppError(
      `Please wait ${Math.round(OTP_RESEND_COOLDOWN_MS / 1000)} seconds before requesting a new code`,
      429,
      ErrorCode.OTP_COOLDOWN,
    );
  }
}

/** Issues a numeric email-verification code. Returns the plaintext code. */
export async function issueVerificationCode(email: string): Promise<string> {
  const code = generateOtp();
  await replaceSecret(email, 'EMAIL_VERIFICATION', await hashOtp(code), OTP_TTL_MS);
  return code;
}

/**
 * Verifies and consumes an email-verification code. Failed attempts are
 * counted atomically and the code is destroyed after OTP_MAX_ATTEMPTS.
 */
export async function verifyVerificationCode(email: string, code: string): Promise<void> {
  const record = await Otp.findOne({ email, purpose: 'EMAIL_VERIFICATION' })
    .sort({ createdAt: -1 })
    .select('+secretHash');

  if (!record) {
    throw new AppError(
      'Code not found or expired. Request a new one.',
      400,
      ErrorCode.OTP_NOT_FOUND,
    );
  }

  if (record.expiresAt <= new Date()) {
    await Otp.deleteOne({ _id: record._id });
    throw new AppError('Code expired. Request a new one.', 400, ErrorCode.OTP_EXPIRED);
  }

  if (record.attempts >= OTP_MAX_ATTEMPTS) {
    await Otp.deleteOne({ _id: record._id });
    throw new AppError(
      'Too many failed attempts. Request a new code.',
      429,
      ErrorCode.OTP_MAX_ATTEMPTS,
    );
  }

  if (!(await verifyOtpHash(code, record.secretHash))) {
    const updated = await Otp.findOneAndUpdate(
      { _id: record._id, attempts: { $lt: OTP_MAX_ATTEMPTS } },
      { $inc: { attempts: 1 } },
      { returnDocument: 'after' },
    );
    if (!updated || updated.attempts >= OTP_MAX_ATTEMPTS) {
      await Otp.deleteOne({ _id: record._id });
    }
    throw new AppError('Invalid code', 400, ErrorCode.OTP_INVALID);
  }

  // Consume atomically so a code can only be used once.
  const consumed = await Otp.deleteOne({ _id: record._id });
  if (consumed.deletedCount !== 1) {
    throw new AppError('Code already used. Request a new one.', 400, ErrorCode.OTP_INVALID);
  }
}

/** Issues a password-reset / account-setup link token. Returns the plaintext token. */
export async function issuePasswordResetToken(
  email: string,
  ttlMs: number = PASSWORD_RESET_TTL_MS,
): Promise<string> {
  const token = generateSecureToken();
  await replaceSecret(email, 'PASSWORD_RESET', hashToken(token), ttlMs);
  return token;
}

/** Validates and consumes a password-reset token (single use, race-safe). */
export async function consumePasswordResetToken(email: string, token: string): Promise<void> {
  const record = await Otp.findOne({ email, purpose: 'PASSWORD_RESET' })
    .sort({ createdAt: -1 })
    .select('+secretHash');

  if (!record) {
    throw new AppError('Invalid or expired reset link', 400, ErrorCode.TOKEN_INVALID);
  }

  if (record.expiresAt <= new Date()) {
    await Otp.deleteOne({ _id: record._id });
    throw new AppError('Reset link expired. Request a new one.', 400, ErrorCode.TOKEN_EXPIRED);
  }

  if (!safeEqual(hashToken(token), record.secretHash)) {
    throw new AppError('Invalid or expired reset link', 400, ErrorCode.TOKEN_INVALID);
  }

  const consumed = await Otp.deleteOne({ _id: record._id, secretHash: record.secretHash });
  if (consumed.deletedCount !== 1) {
    throw new AppError('Reset link already used', 400, ErrorCode.TOKEN_INVALID);
  }
}

/** Removes outstanding secrets for one or more emails (all purposes by default). */
export async function clearSecrets(
  email: string | string[],
  purposes?: OtpPurpose[],
): Promise<void> {
  await Otp.deleteMany({
    email: Array.isArray(email) ? { $in: email } : email,
    ...(purposes ? { purpose: { $in: purposes } } : {}),
  });
}

async function replaceSecret(
  email: string,
  purpose: OtpPurpose,
  secretHash: string,
  ttlMs: number,
) {
  await Otp.deleteMany({ email, purpose });
  await Otp.create({ email, purpose, secretHash, expiresAt: new Date(Date.now() + ttlMs) });
}
