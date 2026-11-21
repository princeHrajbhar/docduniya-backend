import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { BCRYPT_ROUNDS, OTP_LENGTH } from './auth.constants.js';

/** Cryptographically secure numeric one-time code. */
export const generateOtp = (): string => {
  const min = 10 ** (OTP_LENGTH - 1);
  return crypto.randomInt(min, min * 10).toString();
};

/** High-entropy random token (hex). Used for refresh secrets and reset links. */
export const generateSecureToken = (bytes = 32): string =>
  crypto.randomBytes(bytes).toString('hex');

/**
 * SHA-256 is appropriate for high-entropy random tokens (it is not used for
 * passwords or short codes, which use bcrypt).
 */
export const hashToken = (token: string): string =>
  crypto.createHash('sha256').update(token, 'utf8').digest('hex');

/** Constant-time string comparison. */
export const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

export const hashPassword = (password: string): Promise<string> =>
  bcrypt.hash(password, BCRYPT_ROUNDS);

export const hashOtp = (otp: string): Promise<string> => bcrypt.hash(otp, BCRYPT_ROUNDS);

let dummyHash: Promise<string> | undefined;

/**
 * Compares a password with a stored hash. When there is no hash (unknown user
 * or Google-only account) a dummy hash is still compared so response timing
 * does not reveal whether the account exists.
 */
export const verifyPassword = async (password: string, hash?: string | null): Promise<boolean> => {
  if (hash) return bcrypt.compare(password, hash);
  dummyHash ??= bcrypt.hash(generateSecureToken(16), BCRYPT_ROUNDS);
  await bcrypt.compare(password, await dummyHash);
  return false;
};

export const verifyOtpHash = (otp: string, hash: string): Promise<boolean> =>
  bcrypt.compare(otp, hash);
