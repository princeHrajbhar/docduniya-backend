import slugify from 'slugify';
import { AppError, ErrorCode } from '../../../../utils/app-error.js';
import { isDuplicateKeyError } from '../../../../utils/mongo.js';
import { DEFAULT_USER_ROLE, SUPER_ADMIN_ROLE } from '../auth.constants.js';
import { User } from '../models/user.model.js';
import { ALL_PERMISSIONS, type Permission } from './permission.constants.js';
import { AccessRole } from './role.model.js';
import type { CreateRoleInput, UpdateRoleInput } from './role.validation.js';

export const SYSTEM_ROLE_DEFINITIONS: ReadonlyArray<{
  name: string;
  slug: string;
  description: string;
  permissions: Permission[];
  isAssignable: boolean;
}> = [
  {
    name: 'User',
    slug: DEFAULT_USER_ROLE,
    description: 'Standard account without dashboard administration access.',
    permissions: [],
    isAssignable: true,
  },
  {
    name: 'Super Admin',
    slug: SUPER_ADMIN_ROLE,
    description: 'Unrestricted platform owner with role, permission and security administration.',
    permissions: ALL_PERMISSIONS,
    isAssignable: true,
  },
];

const toSlug = (value: string) => slugify(value, { lower: true, strict: true, trim: true });

let systemRolesReady: Promise<void> | undefined;

/** Idempotently seeds system roles. Memoised per process; retried after a failure. */
export function ensureSystemRoles(): Promise<void> {
  systemRolesReady ??= Promise.all(
    SYSTEM_ROLE_DEFINITIONS.map((role) =>
      AccessRole.updateOne(
        { slug: role.slug },
        {
          $set: {
            name: role.name,
            description: role.description,
            permissions: role.permissions,
            isSystem: true,
            isAssignable: role.isAssignable,
          },
          $setOnInsert: { slug: role.slug },
        },
        { upsert: true },
      ),
    ),
  )
    .then(() => undefined)
    .catch((error: unknown) => {
      systemRolesReady = undefined;
      throw error;
    });
  return systemRolesReady;
}

export async function getRolePermissions(roleSlug: string): Promise<Permission[]> {
  await ensureSystemRoles();
  const role = await AccessRole.findOne({ slug: roleSlug }).select('permissions').lean();
  return role?.permissions ?? [];
}

export async function roleExists(roleSlug: string): Promise<boolean> {
  await ensureSystemRoles();
  return Boolean(await AccessRole.exists({ slug: roleSlug, isAssignable: true }));
}

export class RoleService {
  async list() {
    await ensureSystemRoles();
    const [roles, userCounts] = await Promise.all([
      AccessRole.find().sort({ isSystem: -1, name: 1 }).lean(),
      User.aggregate<{ _id: string; count: number }>([
        { $group: { _id: '$role', count: { $sum: 1 } } },
      ]),
    ]);
    const counts = new Map(userCounts.map((item) => [item._id, item.count]));
    return roles.map((role) => ({
      ...role,
      id: String(role._id),
      userCount: counts.get(role.slug) ?? 0,
    }));
  }

  async listAssignable() {
    const roles = await this.list();
    return roles
      .filter((role) => role.isAssignable)
      .map((role) => ({ id: role.id, name: role.name, slug: role.slug, isSystem: role.isSystem }));
  }

  async create(input: CreateRoleInput) {
    await ensureSystemRoles();
    const slug = toSlug(input.slug || input.name);
    if (!slug) throw new AppError('Role slug is required', 400, ErrorCode.VALIDATION_ERROR);
    if (SYSTEM_ROLE_DEFINITIONS.some((role) => role.slug === slug)) {
      throw new AppError('System role names are reserved', 409, ErrorCode.DUPLICATE_ENTRY);
    }

    try {
      const role = await AccessRole.create({ ...input, slug, isSystem: false, isAssignable: true });
      return { ...role.toObject(), id: String(role._id), userCount: 0 };
    } catch (error) {
      if (isDuplicateKeyError(error))
        throw new AppError('Role slug already exists', 409, ErrorCode.DUPLICATE_ENTRY);
      throw error;
    }
  }

  async update(id: string, input: UpdateRoleInput) {
    await ensureSystemRoles();
    const role = await AccessRole.findById(id);
    if (!role) throw new AppError('Role not found', 404, ErrorCode.NOT_FOUND);

    if (role.isSystem) {
      const allowed = new Set(['description', 'isAssignable']);
      if (Object.keys(input).some((key) => !allowed.has(key))) {
        throw new AppError(
          'System role names and permissions cannot be changed',
          400,
          ErrorCode.BAD_REQUEST,
        );
      }
      if (role.slug === SUPER_ADMIN_ROLE && input.isAssignable === false) {
        throw new AppError('Super Admin must remain assignable', 400, ErrorCode.BAD_REQUEST);
      }
    }

    if (input.name !== undefined) role.name = input.name;
    if (input.description !== undefined) role.description = input.description;
    if (input.permissions !== undefined) role.permissions = input.permissions;
    if (input.isAssignable !== undefined) role.isAssignable = input.isAssignable;
    if (input.slug !== undefined) {
      const slug = toSlug(input.slug);
      if (!slug) throw new AppError('Role slug is required', 400, ErrorCode.VALIDATION_ERROR);
      if (slug !== role.slug && (await User.exists({ role: role.slug }))) {
        throw new AppError(
          'A role slug cannot be changed while users are assigned to it',
          409,
          ErrorCode.CONFLICT,
        );
      }
      role.slug = slug;
    }

    try {
      await role.save();
      return {
        ...role.toObject(),
        id: String(role._id),
        userCount: await User.countDocuments({ role: role.slug }),
      };
    } catch (error) {
      if (isDuplicateKeyError(error))
        throw new AppError('Role slug already exists', 409, ErrorCode.DUPLICATE_ENTRY);
      throw error;
    }
  }

  async remove(id: string): Promise<void> {
    await ensureSystemRoles();
    const role = await AccessRole.findById(id);
    if (!role) throw new AppError('Role not found', 404, ErrorCode.NOT_FOUND);
    if (role.isSystem)
      throw new AppError('System roles cannot be deleted', 400, ErrorCode.BAD_REQUEST);
    if (await User.exists({ role: role.slug })) {
      throw new AppError('Reassign users before deleting this role', 409, ErrorCode.CONFLICT);
    }
    await role.deleteOne();
  }
}

export const roleService = new RoleService();
