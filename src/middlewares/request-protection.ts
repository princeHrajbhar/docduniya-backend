import type { NextFunction, Request, Response } from 'express';
import { AUTH_COOKIES } from '../modules/admin/auth/auth.constants.js';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_OBJECT_DEPTH = 20;
const MAX_OBJECT_KEYS = 10_000;

/**
 * Blocks browser cross-site mutation attempts when cookie authentication is in
 * use (CSRF defence in depth on top of SameSite cookies). Non-browser API
 * clients remain supported through bearer tokens.
 */
export function crossSiteMutationGuard(req: Request, res: Response, next: NextFunction): void {
  if (!UNSAFE_METHODS.has(req.method)) return next();

  const cookies = req.cookies as Record<string, unknown> | undefined;
  const fetchSite = req.get('sec-fetch-site')?.toLowerCase();
  const hasSessionCookie = Boolean(
    cookies?.[AUTH_COOKIES.access] || cookies?.[AUTH_COOKIES.refresh],
  );
  const hasBearerToken = req.get('authorization')?.toLowerCase().startsWith('bearer ');

  if (hasSessionCookie && !hasBearerToken && fetchSite === 'cross-site') {
    res.status(403).json({
      success: false,
      code: 'CROSS_SITE_REQUEST_BLOCKED',
      message: 'Cross-site state-changing requests are not allowed.',
    });
    return;
  }

  next();
}

/**
 * Prevents MongoDB operator/path injection (`$where`, `a.b`) and pathological
 * deeply nested payloads before they reach validators or persistence code.
 */
export function requestShapeGuard(req: Request, res: Response, next: NextFunction): void {
  try {
    let keyCount = 0;
    const onKey = () => {
      keyCount += 1;
      if (keyCount > MAX_OBJECT_KEYS) throw new Error('Request contains too many fields');
    };
    inspect(req.body, 'body', 0, onKey);
    inspect(req.query, 'query', 0, onKey);
    inspect(req.params, 'params', 0, onKey);
    next();
  } catch (error) {
    res.status(400).json({
      success: false,
      code: 'UNSAFE_REQUEST_SHAPE',
      message: error instanceof Error ? error.message : 'Unsafe request structure',
    });
  }
}

function inspect(value: unknown, path: string, depth: number, onKey: () => void): void {
  if (depth > MAX_OBJECT_DEPTH) throw new Error('Request nesting is too deep');
  if (!value || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    value.forEach((item, index) => inspect(item, `${path}[${index}]`, depth + 1, onKey));
    return;
  }

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    onKey();
    if (key.startsWith('$') || key.includes('.')) {
      throw new Error(`Unsafe field name detected at ${path}`);
    }
    inspect(nested, `${path}.${key}`, depth + 1, onKey);
  }
}
