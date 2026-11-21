import mongoose, { type Types } from 'mongoose';
import { logger } from '../../../config/logger.js';
import { AppError, ErrorCode } from '../../../utils/app-error.js';
import {
  MAX_SESSIONS_PER_USER,
  REFRESH_TOKEN_SEPARATOR,
  SESSION_TTL_MS,
} from './auth.constants.js';
import { generateSecureToken, hashToken, safeEqual } from './auth.crypto.js';
import { generateAccessToken } from './auth.jwt.js';
import type { AuthTokens, SessionMeta } from './auth.types.js';
import { Session } from './models/session.model.js';
import { User } from './models/user.model.js';

/**
 * Refresh tokens have the form `<sessionId>.<secret>`. Only SHA-256(secret) is
 * stored. Each refresh rotates the secret; presenting a stale secret is treated
 * as token theft and revokes the session.
 */

export const buildRefreshToken = (sessionId: string, secret: string): string =>
  `${sessionId}${REFRESH_TOKEN_SEPARATOR}${secret}`;

export function parseRefreshToken(
  token: string,
): { sessionId: string; secret: string } | undefined {
  const index = token.indexOf(REFRESH_TOKEN_SEPARATOR);
  if (index <= 0 || index === token.length - 1) return undefined;
  const sessionId = token.slice(0, index);
  const secret = token.slice(index + 1);
  return mongoose.isValidObjectId(sessionId) ? { sessionId, secret } : undefined;
}

export async function createSession(
  user: { _id: Types.ObjectId; role: string },
  meta: SessionMeta = {},
): Promise<AuthTokens & { sessionId: string }> {
  const now = new Date();

  // Enforce the per-user session cap by evicting the least recently used sessions.
  const active = await Session.find({ userId: user._id, expiresAt: { $gt: now } })
    .sort({ lastUsedAt: 1 })
    .select('_id')
    .lean();
  if (active.length >= MAX_SESSIONS_PER_USER) {
    const evict = active.slice(0, active.length - MAX_SESSIONS_PER_USER + 1).map((s) => s._id);
    await Session.deleteMany({ _id: { $in: evict } });
  }

  const secret = generateSecureToken();
  const session = await Session.create({
    userId: user._id,
    refreshTokenHash: hashToken(secret),
    ...(meta.userAgent ? { userAgent: meta.userAgent.slice(0, 512) } : {}),
    ...(meta.ip ? { ip: meta.ip.slice(0, 64) } : {}),
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    lastUsedAt: now,
  });

  const sessionId = session._id.toString();
  return {
    sessionId,
    accessToken: generateAccessToken(user._id.toString(), user.role, sessionId),
    refreshToken: buildRefreshToken(sessionId, secret),
  };
}

export async function rotateSession(refreshToken: string): Promise<AuthTokens> {
  const parsed = parseRefreshToken(refreshToken);
  if (!parsed) throw new AppError('Invalid refresh token', 401, ErrorCode.TOKEN_INVALID);

  const now = new Date();
  const session = await Session.findById(parsed.sessionId).select('+refreshTokenHash');
  if (!session || session.expiresAt <= now) {
    throw new AppError('Session not found or expired', 401, ErrorCode.SESSION_NOT_FOUND);
  }

  if (!safeEqual(hashToken(parsed.secret), session.refreshTokenHash)) {
    await Session.deleteOne({ _id: session._id });
    logger.warn(
      { sessionId: parsed.sessionId, userId: session.userId },
      'Refresh token replay detected; session revoked',
    );
    throw new AppError('Invalid refresh token', 401, ErrorCode.TOKEN_INVALID);
  }

  const user = await User.findById(session.userId).select('role isVerified isActive').lean();
  if (!user || !user.isVerified || !user.isActive) {
    await Session.deleteOne({ _id: session._id });
    throw new AppError('Account is not available', 401, ErrorCode.SESSION_NOT_FOUND);
  }

  const newSecret = generateSecureToken();
  // Compare-and-swap: only one concurrent refresh with the same token can win.
  const rotated = await Session.updateOne(
    { _id: session._id, refreshTokenHash: session.refreshTokenHash, expiresAt: { $gt: now } },
    {
      $set: {
        refreshTokenHash: hashToken(newSecret),
        lastUsedAt: now,
        expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      },
    },
  );
  if (rotated.modifiedCount !== 1) {
    throw new AppError('Refresh token already used', 401, ErrorCode.TOKEN_INVALID);
  }

  const sessionId = session._id.toString();
  return {
    accessToken: generateAccessToken(user._id.toString(), user.role, sessionId),
    refreshToken: buildRefreshToken(sessionId, newSecret),
  };
}

/** Revokes the session identified by a refresh token. Silently ignores invalid tokens. */
export async function revokeByRefreshToken(refreshToken: string): Promise<void> {
  const parsed = parseRefreshToken(refreshToken);
  if (!parsed) return;
  const result = await Session.deleteOne({
    _id: parsed.sessionId,
    refreshTokenHash: hashToken(parsed.secret),
  });
  if (result.deletedCount)
    logger.info({ sessionId: parsed.sessionId }, 'Session revoked on logout');
}

export async function isSessionActive(sessionId: string, userId: string): Promise<boolean> {
  if (!mongoose.isValidObjectId(sessionId) || !mongoose.isValidObjectId(userId)) return false;
  return Boolean(await Session.exists({ _id: sessionId, userId, expiresAt: { $gt: new Date() } }));
}

export async function revokeAllSessions(
  userId: string | Types.ObjectId,
  options: { exceptSessionId?: string } = {},
): Promise<number> {
  const result = await Session.deleteMany({
    userId,
    ...(options.exceptSessionId ? { _id: { $ne: options.exceptSessionId } } : {}),
  });
  return result.deletedCount;
}

export async function revokeSession(userId: string, sessionId: string): Promise<boolean> {
  const result = await Session.deleteOne({ _id: sessionId, userId });
  return result.deletedCount === 1;
}

export async function listActiveSessions(userId: string, currentSessionId?: string) {
  const sessions = await Session.find({ userId, expiresAt: { $gt: new Date() } })
    .select('_id userAgent ip lastUsedAt createdAt expiresAt')
    .sort({ lastUsedAt: -1 })
    .lean();

  return sessions.map((session) => ({
    id: session._id.toString(),
    userAgent: session.userAgent,
    ip: session.ip,
    lastUsedAt: session.lastUsedAt,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    ...(currentSessionId !== undefined
      ? { current: session._id.toString() === currentSessionId }
      : {}),
  }));
}
