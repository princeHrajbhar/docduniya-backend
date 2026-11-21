import { z } from 'zod';
import { objectIdSchema, roleSlugSchema } from '../auth.validation.js';
import { ALL_PERMISSIONS, isPermission, type Permission } from './permission.constants.js';

const permissionSchema = z.custom<Permission>(isPermission, { message: 'Unknown permission' });

export const createRoleSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    slug: roleSlugSchema.optional(),
    description: z.string().trim().max(500).optional(),
    permissions: z
      .array(permissionSchema)
      .max(ALL_PERMISSIONS.length)
      .default([])
      .transform((items) => [...new Set(items)]),
  })
  .strict();

export const updateRoleSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    slug: roleSlugSchema.optional(),
    description: z.string().trim().max(500).optional(),
    permissions: z
      .array(permissionSchema)
      .max(ALL_PERMISSIONS.length)
      .transform((items) => [...new Set(items)])
      .optional(),
    isAssignable: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'At least one field is required' });

export const roleIdParamsSchema = z.object({ id: objectIdSchema });

export type CreateRoleInput = z.infer<typeof createRoleSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
