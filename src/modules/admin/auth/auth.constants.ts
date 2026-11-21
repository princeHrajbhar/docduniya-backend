/** bcrypt cost for passwords and OTP codes. Every password in the system uses this policy. */
export const BCRYPT_ROUNDS = 12;

// ── Tokens & sessions ───────────────────────────────────────────────────────
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_SESSIONS_PER_USER = 5;
export const REFRESH_TOKEN_SEPARATOR = '.';

// ── Brute-force protection ──────────────────────────────────────────────────
export const LOGIN_LOCK_ATTEMPTS = 10;
export const LOGIN_LOCK_DURATION_MS = 15 * 60 * 1000;

// ── One-time codes & links ──────────────────────────────────────────────────
export const OTP_LENGTH = 6;
export const OTP_TTL_MS = 5 * 60 * 1000;
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const PASSWORD_RESET_TTL_MS = 5 * 60 * 1000;
export const ACCOUNT_SETUP_TTL_MS = 24 * 60 * 60 * 1000;

// ── Cookies ─────────────────────────────────────────────────────────────────
export const AUTH_COOKIES = {
  access: 'accessToken',
  refresh: 'refreshToken',
} as const;

// ── Roles ───────────────────────────────────────────────────────────────────
export const SUPER_ADMIN_ROLE = 'super-admin';
export const DEFAULT_USER_ROLE = 'user';
export const ROLE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const minutes = (ms: number): number => Math.round(ms / 60_000);
