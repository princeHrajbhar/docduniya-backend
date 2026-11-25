import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { env, isProduction } from '../../../../config/env.js';

/** RFC 6238 TOTP (HMAC-SHA1, 30 s step, 6 digits) with RFC 4648 base32 secrets. */
const STEP_SECONDS = 30;
const DIGITS = 6;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/=+$/u, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Invalid base32 secret');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export const currentStep = (at = Date.now()) => Math.floor(at / 1000 / STEP_SECONDS);

export function totpAt(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', secret).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = (digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(binary).padStart(DIGITS, '0');
}

/**
 * Accepts the current step ±1 for clock drift. Returns the matched step so callers can reject
 * a replay of the same or an earlier step.
 */
export function verifyTotp(secret: Buffer, code: string, at = Date.now()): number | undefined {
  if (!/^\d{6}$/u.test(code)) return undefined;
  const now = currentStep(at);
  for (const step of [now - 1, now, now + 1]) {
    const expected = Buffer.from(totpAt(secret, step));
    if (timingSafeEqual(expected, Buffer.from(code))) return step;
  }
  return undefined;
}

export const newSecret = () => randomBytes(20);

export function otpauthUri(secret: Buffer, account: string, issuer = 'DocDuniya') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${base32Encode(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

/** AES-256-GCM key: the configured key, or (outside production only) a key derived from JWT. */
function encryptionKey(): Buffer {
  if (env.MFA_ENCRYPTION_KEY) {
    const key = Buffer.from(env.MFA_ENCRYPTION_KEY, 'base64');
    if (key.length !== 32) throw new Error('MFA_ENCRYPTION_KEY must be 32 bytes (base64)');
    return key;
  }
  if (isProduction) throw new Error('MFA_ENCRYPTION_KEY is required in production');
  return Buffer.from(
    hkdfSync('sha256', env.JWT_ACCESS_SECRET, 'docduniya-mfa', 'totp-secret-encryption', 32),
  );
}

export function sealSecret(secret: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const body = Buffer.concat([cipher.update(secret), cipher.final()]);
  return [
    'v1',
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    body.toString('base64'),
  ].join('.');
}

export function openSecret(sealed: string): Buffer {
  const [version, iv, tag, body] = sealed.split('.');
  if (version !== 'v1' || !iv || !tag || !body) throw new Error('Unsupported sealed secret');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]);
}

export const hashCode = (code: string) =>
  createHash('sha256').update(code.replaceAll('-', '').toUpperCase()).digest('hex');

/** Ten single-use recovery codes, formatted XXXXX-XXXXX. */
export function recoveryCodes(): string[] {
  return Array.from({ length: 10 }, () => {
    const raw = base32Encode(randomBytes(7)).slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}
