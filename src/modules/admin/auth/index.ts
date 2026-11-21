export { default as authRoutes } from './auth.routes.js';
export { default as roleRoutes } from './roles/role.routes.js';
export {
  protect,
  optionalAuth,
  requirePermission,
  requireAnyPermission,
  hasPermission,
} from './auth.middleware.js';
export { PERMISSIONS, type Permission } from './roles/permission.constants.js';
export { ensureSystemRoles, roleExists, getRolePermissions } from './roles/role.service.js';
export { User, type IUser, type UserDocument } from './models/user.model.js';
export { SUPER_ADMIN_ROLE, DEFAULT_USER_ROLE } from './auth.constants.js';
export { hashPassword } from './auth.crypto.js';
export { sendAccountSetupLink } from './auth.service.js';
export { clearSecrets } from './otp.service.js';
export { revokeAllSessions, revokeSession, listActiveSessions } from './session.service.js';
export { emailSchema, passwordSchema, roleSlugSchema, objectIdSchema } from './auth.validation.js';
export type { AuthContext } from './auth.types.js';
