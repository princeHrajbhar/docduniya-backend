import { z } from 'zod';
import { objectIdSchema } from '../auth/index.js';
import { BLOG_SLUG_PATTERN, BLOG_STATUSES, MAX_BLOG_RESOURCES } from './blog.model.js';

const httpUrl = z
  .string()
  .trim()
  .url('Invalid URL format')
  .refine((value) => /^https?:\/\//i.test(value), 'URL must start with http:// or https://');

const faqItemSchema = z.object({
  question: z.string().trim().min(1, 'Question is required').max(500, 'Question is too long'),
  answer: z.string().trim().min(1, 'Answer is required').max(5000, 'Answer is too long'),
});

const socialMediaLinkSchema = z.object({
  platform: z.string().trim().min(1, 'Platform is required').max(100, 'Platform is too long'),
  url: httpUrl,
});

const resourceLinkSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200, 'Title is too long'),
  url: httpUrl,
});

const titleSchema = z
  .string()
  .trim()
  .min(3, 'Title must be at least 3 characters')
  .max(200, 'Title is too long');

/** Admin input may have outside whitespace; uppercase is still rejected. */
const writableSlugSchema = z
  .string()
  .trim()
  .min(3, 'Slug must be at least 3 characters')
  .max(100, 'Slug is too long')
  .regex(
    BLOG_SLUG_PATTERN,
    'Slug must contain lowercase letters, numbers, and single hyphens only',
  );

/** Public route parameter: must match exactly (no trimming or lowercasing). */
const exactRouteSlugSchema = z
  .string()
  .min(3)
  .max(100)
  .regex(BLOG_SLUG_PATTERN, 'Invalid blog slug');

const descriptionSchema = z
  .string()
  .trim()
  .min(10, 'Description must be at least 10 characters')
  .max(2000, 'Description is too long');

const categorySchema = z
  .string()
  .trim()
  .min(1, 'Category is required')
  .max(150, 'Category is too long');
const postedBySchema = z
  .string()
  .trim()
  .min(1, 'PostedBy is required')
  .max(200, 'PostedBy is too long');
const keywordSchema = z.array(z.string().trim().min(1).max(100)).max(100, 'Too many keywords');
const faqSchema = z.array(faqItemSchema).max(100, 'Too many FAQs');
const socialMediaLinksSchema = z
  .array(socialMediaLinkSchema)
  .max(30, 'Too many social media links');
const resourceLinksSchema = z.array(resourceLinkSchema).max(100, 'Too many resource links');
const seoTitleSchema = z.string().trim().max(200, 'SEO title is too long');
const seoDescriptionSchema = z.string().trim().max(500, 'SEO description is too long');
const contentSchema = z
  .string()
  .min(10, 'Content must be at least 10 characters')
  .max(2_000_000, 'Content is too long');
const statusSchema = z.enum(BLOG_STATUSES);

export const createBlogSchema = z.object({
  title: titleSchema,
  slug: writableSlugSchema,
  description: descriptionSchema,
  category: categorySchema,
  keyword: keywordSchema.default([]),
  postingDate: z.coerce.date().optional(),
  postedBy: postedBySchema,
  socialMediaLinks: socialMediaLinksSchema.default([]),
  resourceLinks: resourceLinksSchema.default([]),
  faq: faqSchema.default([]),
  seoTitle: seoTitleSchema.default(''),
  seoDescription: seoDescriptionSchema.default(''),
  content: contentSchema,
  status: statusSchema.default('draft'),
});

export const updateBlogSchema = z.object({
  title: titleSchema.optional(),
  slug: writableSlugSchema.optional(),
  description: descriptionSchema.optional(),
  category: categorySchema.optional(),
  keyword: keywordSchema.optional(),
  postingDate: z.coerce.date().optional(),
  postedBy: postedBySchema.optional(),
  socialMediaLinks: socialMediaLinksSchema.optional(),
  resourceLinks: resourceLinksSchema.optional(),
  faq: faqSchema.optional(),
  seoTitle: seoTitleSchema.optional(),
  seoDescription: seoDescriptionSchema.optional(),
  content: contentSchema.optional(),
  status: statusSchema.optional(),
});

export const blogFileMetadataSchema = z.object({
  storageKey: z.string().trim().min(1).optional(),
  title: z.string().trim().max(200, 'Media title is too long').optional(),
  description: z.string().trim().max(1000, 'Media description is too long').optional(),
  altText: z.string().trim().max(300, 'Alt text is too long').optional(),
  caption: z.string().trim().max(500, 'Caption is too long').optional(),
});

export const blogFileControlsSchema = z.object({
  /** When present, only these existing resources are kept (in this order). */
  retainedFileStorageKeys: z
    .array(z.string().trim().min(1))
    .max(MAX_BLOG_RESOURCES, `A blog can retain at most ${MAX_BLOG_RESOURCES} uploaded resources`)
    .optional(),
  removeBanner: z.boolean().optional().default(false),
  bannerSeo: blogFileMetadataSchema.optional(),
  /** Entries with `storageKey` edit retained files; others apply to new uploads in order. */
  resourceSeo: z
    .array(blogFileMetadataSchema)
    .max(MAX_BLOG_RESOURCES * 2)
    .optional(),
});

export const getBlogsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  status: statusSchema.optional(),
  category: z.string().trim().min(1).max(150).optional(),
  search: z.string().trim().min(1).max(200).optional(),
  sortBy: z.enum(['createdAt', 'postingDate', 'title']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const blogIdParamsSchema = z.object({ id: objectIdSchema });

export const blogSlugParamsSchema = z.object({ slug: exactRouteSlugSchema });

export const bulkDeleteBlogsSchema = z.object({
  ids: z
    .array(objectIdSchema)
    .min(1, 'IDs array is required')
    .max(100, 'You can delete at most 100 blogs at once'),
});

export const updateBlogStatusSchema = z.object({ status: statusSchema });

export type CreateBlogInput = z.infer<typeof createBlogSchema>;
export type UpdateBlogInput = z.infer<typeof updateBlogSchema>;
export type GetBlogsInput = z.infer<typeof getBlogsSchema>;
export type BlogFileControls = z.infer<typeof blogFileControlsSchema>;
