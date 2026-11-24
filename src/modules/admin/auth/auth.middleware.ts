import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { AppError, ErrorCode } from '../../../utils/app-error.js';
import { AUTH_COOKIES, SUPER_ADMIN_ROLE } from './auth.constants.js';
import { verifyAccessToken } from './auth.jwt.js';
import type { Permission } from './roles/permission.constants.js';
import { getRolePermissions } from './roles/role.service.js';
import { isSessionActive } from './session.service.js';
import { User } from './models/user.model.js';

/**
 * Authenticates the request from `Authorization: Bearer <token>` or the
 * access-token cookie. JWT validity alone is not enough: the backing session
 * must still exist, so logout / logout-all / password reset revoke access
 * immediately instead of after the token's 15 minute lifetime.
 */
export async function protect(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = extractAccessToken(req);
  if (!token) return next(new AppError('Authentication required', 401, ErrorCode.TOKEN_INVALID));

  let decoded;
  try {
    decoded = verifyAccessToken(token);
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return next(
        new AppError('Session expired, please log in again', 401, ErrorCode.TOKEN_EXPIRED),
      );
    }
    if (error instanceof jwt.JsonWebTokenError) {
      return next(new AppError('Invalid token', 401, ErrorCode.TOKEN_INVALID));
    }
    return next(error);
  }

  if (!(await isSessionActive(decoded.sessionId, decoded.userId))) {
    return next(new AppError('Session expired or revoked', 401, ErrorCode.SESSION_NOT_FOUND));
  }

  const currentUser = await User.findOne({ _id: decoded.userId, isActive: true, isVerified: true })
    .select('role')
    .lean();
  if (!currentUser)
    return next(new AppError('Account is unavailable', 401, ErrorCode.SESSION_NOT_FOUND));
  req.user = {
    userId: decoded.userId,
    role: currentUser.role,
    sessionId: decoded.sessionId,
    permissions: await getRolePermissions(currentUser.role),
  };
  next();
}

/**
 * For public routes that show extra data to signed-in staff (e.g. draft posts).
 * Sets `req.user` when a valid, active session is presented; otherwise the
 * request simply continues anonymously. Never rejects.
 */
export async function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const token = extractAccessToken(req);
  if (!token) return next();

  try {
    const decoded = verifyAccessToken(token);
    if (await isSessionActive(decoded.sessionId, decoded.userId)) {
      const currentUser = await User.findOne({
        _id: decoded.userId,
        isActive: true,
        isVerified: true,
      })
        .select('role')
        .lean();
      if (!currentUser) return next();
      req.user = {
        userId: decoded.userId,
        role: currentUser.role,
        sessionId: decoded.sessionId,
        permissions: await getRolePermissions(currentUser.role),
      };
    }
  } catch (error) {
    if (!(error instanceof jwt.JsonWebTokenError)) return next(error);
  }
  next();
}

export const hasPermission = (req: Request, permission: Permission): boolean =>
  Boolean(
    req.user && (req.user.role === SUPER_ADMIN_ROLE || req.user.permissions.includes(permission)),
  );

/** Requires every listed permission. Super Admin always passes. Use after `protect`. */
export const requirePermission =
  (...permissions: Permission[]) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user)
      return next(new AppError('Authentication required', 401, ErrorCode.TOKEN_INVALID));
    if (permissions.every((permission) => hasPermission(req, permission))) return next();
    next(new AppError('Insufficient permissions', 403, ErrorCode.FORBIDDEN));
  };

/** Requires at least one of the listed permissions. Use after `protect`. */
export const requireAnyPermission =
  (...permissions: Permission[]) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user)
      return next(new AppError('Authentication required', 401, ErrorCode.TOKEN_INVALID));
    if (permissions.some((permission) => hasPermission(req, permission))) return next();
    next(new AppError('Insufficient permissions', 403, ErrorCode.FORBIDDEN));
  };

function extractAccessToken(req: Request): string | undefined {
  const authorization = req.get('authorization');
  if (authorization) {
    const [scheme, token] = authorization.trim().split(/\s+/, 2);
    if (scheme?.toLowerCase() === 'bearer' && token) return token;
  }

  const cookieToken: unknown = (req.cookies as Record<string, unknown> | undefined)?.[
    AUTH_COOKIES.access
  ];
  return typeof cookieToken === 'string' && cookieToken.length > 0 ? cookieToken : undefined;
}
