import { z } from 'zod';
import {
  DEFAULT_USER_ROLE,
  emailSchema,
  objectIdSchema,
  passwordSchema,
  roleSlugSchema,
} from '../admin/auth/index.js';

export const createUserSchema = z
  .object({
    email: emailSchema,
    /**
     * Optional initial password. Either way the user receives a single-use
     * setup link and must choose their own password; passwords are never emailed.
     */
    password: passwordSchema.optional(),
    role: roleSlugSchema.default(DEFAULT_USER_ROLE),
    // Admin-created accounts skip registration OTP and are verified immediately.
    isVerified: z.literal(true).optional(),
  })
  .strict();

export const updateUserSchema = z
  .object({
    email: emailSchema.optional(),
    password: passwordSchema.optional(),
    isVerified: z.boolean().optional(),
    isActive: z.boolean().optional(),
    role: roleSlugSchema.optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, { message: 'At least one field is required' });

export const verificationSchema = z.object({ isVerified: z.boolean() }).strict();

export const emailPreferenceSchema = z
  .object({ blocked: z.boolean(), reason: z.string().trim().max(500).optional() })
  .strict();

const booleanQuery = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();

export const userQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(10),
    role: roleSlugSchema.optional(),
    isVerified: booleanQuery,
    isActive: booleanQuery,
    search: z.string().trim().max(254).optional(),
  })
  .strict();

export const userIdParamsSchema = z.object({ id: objectIdSchema });

export const userSessionParamsSchema = z.object({ id: objectIdSchema, sessionId: objectIdSchema });

export const emailParamsSchema = z.object({ email: emailSchema });

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type UserQueryInput = z.infer<typeof userQuerySchema>;
