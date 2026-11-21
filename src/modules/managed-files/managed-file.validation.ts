import { z } from 'zod';
import { objectIdSchema } from '../admin/auth/index.js';

export const fileIdParamsSchema = z.object({ id: objectIdSchema });

/** Multipart text fields arrive as strings. */
export const uploadManagedFileSchema = z
  .object({
    /** Admins only: upload on behalf of another user. */
    ownerId: objectIdSchema.optional(),
    visibility: z.enum(['public', 'private']).optional(),
    category: z.string().trim().min(1).max(80).default('general'),
    label: z.string().trim().max(200).optional(),
    /** Admins only: explicit storage folder. */
    folder: z.string().trim().min(1).max(300).optional(),
    filename: z.string().trim().min(1).max(200).optional(),
    optimizeImage: z.enum(['true', 'false']).optional(),
    caption: z.string().trim().max(500).optional(),
    altText: z.string().trim().max(300).optional(),
    description: z.string().trim().max(1000).optional(),
    title: z.string().trim().max(200).optional(),
    metadata: z.preprocess(
      (value) => {
        if (typeof value !== 'string') return value;
        try {
          return JSON.parse(value) as unknown;
        } catch {
          return value;
        }
      },
      z.record(z.string().max(100), z.string().max(500)).optional(),
    ),
  })
  .strict();

export const managedFileListSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    ownerId: objectIdSchema.optional(),
    category: z.string().trim().max(80).optional(),
    search: z.string().trim().max(200).optional(),
  })
  .strict();

export const updateManagedFileSeoSchema = z
  .object({
    label: z.string().trim().max(200).optional(),
    title: z.string().trim().max(200).optional(),
    description: z.string().trim().max(1000).optional(),
    altText: z.string().trim().max(300).optional(),
    caption: z.string().trim().max(500).optional(),
  })
  .strict();

export type UploadManagedFileInput = z.infer<typeof uploadManagedFileSchema>;
export type ManagedFileListQuery = z.infer<typeof managedFileListSchema>;
export type UpdateManagedFileSeoInput = z.infer<typeof updateManagedFileSeoSchema>;
