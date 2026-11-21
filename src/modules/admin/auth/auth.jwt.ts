import jwt, { type JwtPayload } from 'jsonwebtoken';
import { env } from '../../../config/env.js';
import { ACCESS_TOKEN_TTL_SECONDS, ROLE_SLUG_PATTERN } from './auth.constants.js';

const ALGORITHM = 'HS256' as const;

export interface AccessTokenPayload {
  userId: string;
  role: string;
  sessionId: string;
  tokenType: 'access';
}

export const generateAccessToken = (userId: string, role: string, sessionId: string): string =>
  jwt.sign(
    { userId, role, sessionId, tokenType: 'access' } satisfies AccessTokenPayload,
    env.JWT_ACCESS_SECRET,
    {
      algorithm: ALGORITHM,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    },
  );

export const verifyAccessToken = (token: string): AccessTokenPayload => {
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: [ALGORITHM] });

  if (typeof decoded === 'string' || !isAccessPayload(decoded)) {
    throw new jwt.JsonWebTokenError('Invalid access token payload');
  }

  return {
    userId: decoded.userId,
    role: decoded.role,
    sessionId: decoded.sessionId,
    tokenType: 'access',
  };
};

function isAccessPayload(payload: JwtPayload): payload is JwtPayload & AccessTokenPayload {
  return (
    typeof payload.userId === 'string' &&
    typeof payload.sessionId === 'string' &&
    typeof payload.role === 'string' &&
    ROLE_SLUG_PATTERN.test(payload.role) &&
    payload.tokenType === 'access'
  );
}
