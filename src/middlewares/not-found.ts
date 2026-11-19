import type { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/api-error.js';

export const notFound = (req: Request, _res: Response, next: NextFunction) => {
  next(ApiError.notFound(`Route ${req.method} ${req.originalUrl} not found`));
};
