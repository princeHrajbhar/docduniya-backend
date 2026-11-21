import type { AuthContext } from '../modules/admin/auth/auth.types.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by the `protect` middleware for authenticated requests. */
      user?: AuthContext;
    }
  }
}

export {};
