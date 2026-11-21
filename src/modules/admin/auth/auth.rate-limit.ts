import { createRateLimiter } from '../../../middlewares/rate-limit.js';

/** Failed logins only: successful sign-ins do not consume the budget. */
export const loginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
});

/** Anything that sends an email (register, resend code, forgot password). */
export const otpLimiter = createRateLimiter({ windowMs: 10 * 60 * 1000, limit: 5 });

/** Token endpoints and code verification. */
export const authLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, limit: 30 });

export const resetPasswordLimiter = createRateLimiter({ windowMs: 30 * 60 * 1000, limit: 3 });
