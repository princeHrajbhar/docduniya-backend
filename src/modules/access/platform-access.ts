import type { CommandActor } from '../../shared/domain/healthcare.js';
import { ApiError } from '../../utils/api-error.js';
import { User } from '../admin/auth/models/user.model.js';
import type { Permission } from '../admin/auth/roles/permission.constants.js';
import { getRolePermissions } from '../admin/auth/roles/role.service.js';

/** Platform review authority never implies provider membership or patient access. */
export async function requirePlatformPermission(
  actor: CommandActor,
  permission: Permission,
): Promise<void> {
  const user = await User.findOne({ _id: actor.userId, isActive: true, isVerified: true })
    .select('role')
    .lean();
  if (!user || !(await getRolePermissions(user.role)).includes(permission)) {
    throw ApiError.forbidden('Insufficient platform permissions');
  }
}
