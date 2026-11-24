import type { Request, RequestHandler } from 'express';
import { objectId, paginationInput } from '../domain/healthcare.js';
import { param } from './context.js';

/** Wraps a query/command in the `{ success, data }` envelope. Express 5 forwards rejections. */
export function ok(work: (req: Request) => Promise<unknown>, status = 200): RequestHandler {
  return async (req, res) => {
    res.status(status).json({ success: true, data: await work(req) });
  };
}

/** Same as ok, for responses that must never be cached by browsers or intermediaries. */
export function noStore(work: (req: Request) => Promise<unknown>, status = 200): RequestHandler {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(status).json({ success: true, data: await work(req) });
  };
}

export const idParam = (req: Request, name: string) => objectId.parse(param(req, name));
export const pageQuery = (req: Request) => paginationInput.parse(req.query);
