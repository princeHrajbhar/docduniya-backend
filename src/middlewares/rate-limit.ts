import { rateLimit, type Options } from 'express-rate-limit';
import type { Request, Response } from 'express';

const rateLimitHandler = (_req: Request, res: Response): void => {
  res.status(429).json({
    success: false,
    code: 'RATE_LIMIT_EXCEEDED',
    message: 'Too many requests. Please try again later.',
  });
};

/** Creates a limiter with the project's shared defaults and JSON error envelope. */
export const createRateLimiter = (
  options: Partial<Options> & Pick<Options, 'windowMs' | 'limit'>,
) =>
  rateLimit({
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ipv6Subnet: 56,
    handler: rateLimitHandler,
    ...options,
  });

export const uploadLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, limit: 60 });
