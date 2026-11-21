import { ApiError } from './api-error.js';

export const ErrorCode = {
  // Auth
  USER_EXISTS: 'USER_EXISTS',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_NOT_VERIFIED: 'ACCOUNT_NOT_VERIFIED',
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  // OTP
  OTP_NOT_FOUND: 'OTP_NOT_FOUND',
  OTP_EXPIRED: 'OTP_EXPIRED',
  OTP_INVALID: 'OTP_INVALID',
  OTP_MAX_ATTEMPTS: 'OTP_MAX_ATTEMPTS',
  OTP_COOLDOWN: 'OTP_COOLDOWN',
  // Session / token
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  TOKEN_INVALID: 'TOKEN_INVALID',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  // Email
  EMAIL_SUPPRESSED: 'EMAIL_SUPPRESSED',
  EMAIL_DELIVERY_FAILED: 'EMAIL_DELIVERY_FAILED',
  // General
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  INTERNAL: 'INTERNAL',
  BAD_REQUEST: 'BAD_REQUEST',
  DUPLICATE_ENTRY: 'DUPLICATE_ENTRY',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Operational error with a stable `code`. Handled by the global error handler. */
export class AppError extends ApiError {
  constructor(message: string, statusCode: number, code: ErrorCode, details?: unknown) {
    super(statusCode, message, details, code);
    this.name = 'AppError';
  }
}
