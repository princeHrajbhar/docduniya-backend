import type { Permission } from './roles/permission.constants.js';

/** Authenticated principal attached to `req.user` by the `protect` middleware. */
export interface AuthContext {
  userId: string;
  role: string;
  sessionId: string;
  permissions: Permission[];
}

export interface SessionMeta {
  userAgent?: string;
  ip?: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}
