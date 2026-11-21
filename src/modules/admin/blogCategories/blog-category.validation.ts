import { z } from 'zod';
import { objectIdSchema } from '../auth/index.js';
import { BLOG_SLUG_PATTERN } from '../blog/blog.model.js';

const nameSchema = z.string().trim().min(1, 'Name is required').max(150, 'Name is too long');
const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'Slug is required')
  .max(150, 'Slug is too long')
  .regex(
    BLOG_SLUG_PATTERN,
    'Slug must contain lowercase letters, numbers, and single hyphens only',
  );

/** `slug` is generated from `name` when omitted. */
export const createBlogCategorySchema = z
  .object({ name: nameSchema, slug: slugSchema.optional() })
  .strict();

export const updateBlogCategorySchema = z
  .object({ name: nameSchema.optional(), slug: slugSchema.optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'At least one field is required' });

export const blogCategoryIdParamsSchema = z.object({ id: objectIdSchema });
export const blogCategorySlugParamsSchema = z.object({
  slug: z.string().trim().toLowerCase().min(1).max(150),
});

export type CreateBlogCategoryInput = z.infer<typeof createBlogCategorySchema>;
export type UpdateBlogCategoryInput = z.infer<typeof updateBlogCategorySchema>;
