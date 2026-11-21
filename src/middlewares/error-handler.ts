import type { Request, Response, NextFunction } from 'express';
import { MulterError } from 'multer';
import { ZodError, z } from 'zod';
import { ApiError } from '../utils/api-error.js';
import { isDuplicateKeyError } from '../utils/mongo.js';
import { logger } from '../config/logger.js';
import { isProduction } from '../config/env.js';
import { StorageError } from '../modules/file-manager/storage.errors.js';
import { AssetError } from '../modules/assets/asset.error.js';
import { AssetStorageError } from '../modules/assets/storage/storage.error.js';

/**
 * Every error response has the shape:
 *   { success: false, code: string, message: string, errors?: unknown }
 */
const fail = (res: Response, status: number, code: string, message: string, errors?: unknown) =>
  res
    .status(status)
    .json({ success: false, code, message, ...(errors !== undefined && { errors }) });

const requestContext = (req: Request) => ({
  method: req.method,
  path: req.originalUrl,
  ip: req.ip,
});

export const errorHandler = (err: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return;

  if (err instanceof ZodError) {
    const message = err.issues.map((issue) => issue.message).join(', ') || 'Validation failed';
    return fail(res, 400, 'VALIDATION_ERROR', message, z.flattenError(err).fieldErrors);
  }

  if (err instanceof ApiError) {
    if (err.statusCode >= 500)
      logger.warn({ err, ...requestContext(req) }, 'Operational server error');
    return fail(
      res,
      err.statusCode,
      err.code ?? httpCode(err.statusCode),
      err.message,
      err.details,
    );
  }

  if (err instanceof MulterError) {
    const tooLarge = err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_FILE_COUNT';
    return fail(res, tooLarge ? 413 : 400, 'VALIDATION_ERROR', multerMessage(err));
  }

  if (
    err instanceof StorageError ||
    err instanceof AssetStorageError ||
    err instanceof AssetError
  ) {
    if (err.statusCode >= 500)
      logger.warn({ err, ...requestContext(req) }, 'Storage operation failed');
    const details =
      'details' in err && err.details !== undefined && !isProduction ? err.details : undefined;
    return fail(res, err.statusCode, err.code, err.message, details);
  }

  if (isDuplicateKeyError(err)) {
    const field = Object.keys(err.keyPattern ?? {})[0];
    return fail(
      res,
      409,
      'DUPLICATE_ENTRY',
      field ? `A record with this ${field} already exists` : 'A duplicate record already exists',
    );
  }

  if (isNamedError(err, 'ValidationError') && 'errors' in err) {
    const messages = Object.values(err.errors as Record<string, { message: string }>).map(
      (e) => e.message,
    );
    return fail(res, 400, 'VALIDATION_ERROR', messages.join(', ') || 'Validation failed');
  }

  if (isNamedError(err, 'CastError')) {
    return fail(res, 400, 'BAD_REQUEST', 'Invalid identifier or request value');
  }

  // body-parser errors (malformed JSON, payload too large) carry `type` and `status`.
  if (isBodyParserError(err)) {
    const message = err.type === 'entity.parse.failed' ? 'Malformed JSON body' : err.message;
    return fail(res, err.status, err.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST', message);
  }

  if (err instanceof Error && err.message === 'Origin is not allowed by CORS') {
    return fail(res, 403, 'FORBIDDEN', err.message);
  }

  logger.error({ err, ...requestContext(req) }, 'Unhandled error');

  return res.status(500).json({
    success: false,
    code: 'INTERNAL',
    message: 'Internal Server Error',
    ...(!isProduction && err instanceof Error && { stack: err.stack }),
  });
};

function httpCode(status: number): string {
  if (status === 400) return 'BAD_REQUEST';
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  return status >= 500 ? 'INTERNAL' : 'ERROR';
}

function multerMessage(err: MulterError): string {
  if (err.code === 'LIMIT_FILE_SIZE') return 'Uploaded file is too large';
  if (err.code === 'LIMIT_FILE_COUNT') return 'Too many files were uploaded';
  if (err.code === 'LIMIT_UNEXPECTED_FILE')
    return `Unexpected upload field${err.field ? ` "${err.field}"` : ''}`;
  return err.message || 'Invalid file upload';
}

function isNamedError(err: unknown, name: string): err is Error {
  return err instanceof Error && err.name === name;
}

function isBodyParserError(err: unknown): err is Error & { type: string; status: number } {
  if (!(err instanceof Error)) return false;
  const { type, status } = err as Error & { type?: unknown; status?: unknown };
  return typeof type === 'string' && type.startsWith('entity.') && typeof status === 'number';
}
