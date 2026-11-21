import { Schema, model, type HydratedDocument } from 'mongoose';
import { uploadedFileSchema, type UploadedFile } from '../../assets/index.js';

export const BLOG_STATUSES = ['draft', 'published'] as const;
export type BlogStatus = (typeof BLOG_STATUSES)[number];

/** Lowercase letters, digits and single hyphens. */
export const BLOG_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_BLOG_RESOURCES = 10;

export interface BlogFaq {
  question: string;
  answer: string;
}

export interface SocialMediaLink {
  platform: string;
  url: string;
}

export interface ResourceLink {
  title: string;
  url: string;
}

export interface IBlog {
  title: string;
  slug: string;
  description: string;
  category: string;
  keyword: string[];
  postingDate: Date;
  postedBy: string;
  socialMediaLinks: SocialMediaLink[];
  resourceLinks: ResourceLink[];
  banner?: UploadedFile;
  files: UploadedFile[];
  faq: BlogFaq[];
  seoTitle: string;
  seoDescription: string;
  /** Sanitised rich-text HTML. */
  content: string;
  status: BlogStatus;
  createdAt: Date;
  updatedAt: Date;
}

export type BlogDocument = HydratedDocument<IBlog>;

const cleanStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];

const faqSchema = new Schema<BlogFaq>(
  {
    question: { type: String, default: '', trim: true },
    answer: { type: String, default: '', trim: true },
  },
  { _id: false },
);

const socialMediaLinkSchema = new Schema<SocialMediaLink>(
  {
    platform: { type: String, default: '', trim: true },
    url: { type: String, default: '', trim: true },
  },
  { _id: false },
);

const resourceLinkSchema = new Schema<ResourceLink>(
  {
    title: { type: String, default: '', trim: true },
    url: { type: String, default: '', trim: true },
  },
  { _id: false },
);

const blogSchema = new Schema<IBlog>(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    /*
     * No lowercase/trim setters: Mongoose setters also rewrite query values,
     * which would make slug lookups case-insensitive. Slugs are validated
     * as canonical at the API boundary instead.
     */
    slug: {
      type: String,
      required: true,
      unique: true,
      maxlength: 100,
      validate: {
        validator: (value: string) => BLOG_SLUG_PATTERN.test(value),
        message: 'Slug must contain lowercase letters, numbers, and single hyphens only',
      },
    },
    content: { type: String, required: true, default: '' },
    description: { type: String, default: '', trim: true },
    category: { type: String, default: '', trim: true, index: true },
    keyword: { type: [String], default: () => [], set: cleanStringArray },
    postingDate: { type: Date, default: Date.now, index: true },
    postedBy: { type: String, default: '', trim: true },
    socialMediaLinks: { type: [socialMediaLinkSchema], default: () => [] },
    resourceLinks: { type: [resourceLinkSchema], default: () => [] },
    banner: { type: uploadedFileSchema, default: undefined },
    files: { type: [uploadedFileSchema], default: () => [] },
    faq: { type: [faqSchema], default: () => [] },
    seoTitle: { type: String, default: '', trim: true },
    seoDescription: { type: String, default: '', trim: true },
    status: { type: String, enum: BLOG_STATUSES, default: 'draft', required: true, index: true },
  },
  { timestamps: true, versionKey: false, strict: true, minimize: false },
);

blogSchema.index({ title: 'text', description: 'text', content: 'text', keyword: 'text' });
blogSchema.index({ status: 1, category: 1, postingDate: -1 });

export const Blog = model<IBlog>('Blog', blogSchema);
