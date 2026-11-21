import type { CookieOptions, Request, Response } from 'express';
import { env, isProduction } from '../../../config/env.js';
import { ACCESS_TOKEN_TTL_SECONDS, AUTH_COOKIES, SESSION_TTL_MS } from './auth.constants.js';
import type { AuthTokens } from './auth.types.js';

// Use AUTH_COOKIE_SAME_SITE=none only for a genuinely cross-site frontend (requires HTTPS).
const baseCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: isProduction || env.AUTH_COOKIE_SAME_SITE === 'none',
  sameSite: env.AUTH_COOKIE_SAME_SITE,
  path: '/',
  ...(env.AUTH_COOKIE_DOMAIN ? { domain: env.AUTH_COOKIE_DOMAIN } : {}),
};

export function setAuthCookies(res: Response, tokens: AuthTokens): void {
  res.cookie(AUTH_COOKIES.access, tokens.accessToken, {
    ...baseCookieOptions,
    maxAge: ACCESS_TOKEN_TTL_SECONDS * 1000,
  });
  res.cookie(AUTH_COOKIES.refresh, tokens.refreshToken, {
    ...baseCookieOptions,
    maxAge: SESSION_TTL_MS,
  });
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie(AUTH_COOKIES.access, baseCookieOptions);
  res.clearCookie(AUTH_COOKIES.refresh, baseCookieOptions);
}

export function readRefreshCookie(req: Request): string | undefined {
  const value: unknown = (req.cookies as Record<string, unknown> | undefined)?.[
    AUTH_COOKIES.refresh
  ];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
