import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  openSecret,
  sealSecret,
  totpAt,
  verifyTotp,
} from '../src/modules/admin/auth/mfa/totp.js';

// RFC 6238 Appendix B test secret (ASCII "12345678901234567890"), SHA-1, truncated to 6 digits.
const RFC_SECRET = Buffer.from('12345678901234567890');

describe('TOTP', () => {
  it('matches the RFC 6238 SHA-1 vectors', () => {
    expect(totpAt(RFC_SECRET, Math.floor(59 / 30))).toBe('287082');
    expect(totpAt(RFC_SECRET, Math.floor(1111111109 / 30))).toBe('081804');
    expect(totpAt(RFC_SECRET, Math.floor(1234567890 / 30))).toBe('005924');
    expect(totpAt(RFC_SECRET, Math.floor(2000000000 / 30))).toBe('279037');
  });

  it('accepts one step of drift and rejects older codes and malformed input', () => {
    const at = 1_700_000_000_000;
    const step = Math.floor(at / 30_000);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step), at)).toBe(step);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 1), at)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 3), at)).toBeUndefined();
    expect(verifyTotp(RFC_SECRET, '12345', at)).toBeUndefined();
    expect(verifyTotp(RFC_SECRET, 'abcdef', at)).toBeUndefined();
  });

  it('round-trips base32 and sealed secrets without exposing the plaintext', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
    const sealed = sealSecret(RFC_SECRET);
    expect(sealed).not.toContain(RFC_SECRET.toString('base64'));
    expect(openSecret(sealed).equals(RFC_SECRET)).toBe(true);
    const tampered = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'B' : 'A') + sealed.slice(-1);
    expect(() => openSecret(tampered)).toThrow();
  });
});
