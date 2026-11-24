import type { Request } from 'express';
import { ApiError } from '../../utils/api-error.js';
import type { CommandActor } from '../domain/healthcare.js';

export function actor(req: Request): CommandActor {
  if (!req.user) throw ApiError.unauthorized();
  return { userId: req.user.userId, requestId: String(req.id) };
}
export function idempotencyKey(req: Request): string {
  const key = req.get('Idempotency-Key');
  if (!key || !/^[A-Za-z0-9_-]{8,100}$/.test(key)) {
    throw new ApiError(
      400,
      'Idempotency-Key must contain 8–100 letters, digits, underscores or hyphens',
      undefined,
      'IDEMPOTENCY_KEY_REQUIRED',
    );
  }
  return key;
}
export function param(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string') throw ApiError.badRequest('Invalid route parameter');
  return value;
}
