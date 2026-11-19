import type { Request, Response, NextFunction } from 'express';
import { ZodError, z } from 'zod';
import { ApiError } from '../utils/api-error.js';
import { logger } from '../config/logger.js';
import { isProduction } from '../config/env.js';

export const errorHandler = (err: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: z.flattenError(err).fieldErrors,
    });
  }

  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({
      success: false,
      message: err.message,
      ...(err.details !== undefined && { errors: err.details }),
    });
  }

  logger.error({ err, path: req.originalUrl }, 'Unhandled error');

  return res.status(500).json({
    success: false,
    message: 'Internal Server Error',
    ...(!isProduction && err instanceof Error && { stack: err.stack }),
  });
};
