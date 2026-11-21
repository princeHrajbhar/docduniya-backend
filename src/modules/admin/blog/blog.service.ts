import type { QueryFilter } from 'mongoose';
import { AppError, ErrorCode } from '../../../utils/app-error.js';
import {
  deleteMediaFilesQuietly,
  updateMediaMetadata,
  uploadMediaFile,
  uploadMediaFiles,
  type FileMetadataInput,
  type UploadedFile,
} from '../../assets/index.js';
import {
  BLOG_SLUG_PATTERN,
  Blog,
  MAX_BLOG_RESOURCES,
  type BlogDocument,
  type BlogStatus,
  type IBlog,
} from './blog.model.js';
import { sanitizeBlogContent } from './blog.sanitize.js';
import type { CreateBlogInput, GetBlogsInput, UpdateBlogInput } from './blog.validation.js';

const BANNER_FOLDER = 'blogs/banners';
const RESOURCE_FOLDER = 'blogs/resources';

export interface BlogFileOptions {
  bannerFile?: Express.Multer.File;
  resourceFiles?: Express.Multer.File[];
  retainedFileStorageKeys?: string[];
  removeBanner?: boolean;
  bannerSeo?: FileMetadataInput;
  resourceSeo?: FileMetadataInput[];
}

const notFound = () => new AppError('Blog not found', 404, ErrorCode.NOT_FOUND);

const plainFile = (file: UploadedFile): UploadedFile => {
  const source = file as UploadedFile & { toObject?: () => UploadedFile };
  return typeof source.toObject === 'function' ? source.toObject() : { ...file };
};

const storageKeysOf = (blog: Pick<IBlog, 'banner' | 'files'>): string[] => [
  ...(blog.banner?.storageKey ? [blog.banner.storageKey] : []),
  ...blog.files.map((file) => file.storageKey),
];

async function assertUniqueSlug(slug: string, excludedId?: string): Promise<void> {
  const duplicate = await Blog.exists({
    slug,
    ...(excludedId ? { _id: { $ne: excludedId } } : {}),
  }).collation({
    locale: 'simple',
  });
  if (duplicate) {
    throw new AppError(
      'Slug already exists. Please use a unique slug.',
      409,
      ErrorCode.DUPLICATE_ENTRY,
    );
  }
}

function assertResourceLimit(count: number): void {
  if (count > MAX_BLOG_RESOURCES) {
    throw new AppError(
      `A blog can contain at most ${MAX_BLOG_RESOURCES} uploaded resources.`,
      400,
      ErrorCode.VALIDATION_ERROR,
    );
  }
}

class BlogService {
  async createBlog(data: CreateBlogInput, files: BlogFileOptions = {}): Promise<BlogDocument> {
    await assertUniqueSlug(data.slug);
    const resourceFiles = files.resourceFiles ?? [];
    assertResourceLimit(resourceFiles.length);

    const uploaded: UploadedFile[] = [];
    try {
      const banner = files.bannerFile
        ? await uploadMediaFile(files.bannerFile, BANNER_FOLDER, files.bannerSeo)
        : undefined;
      if (banner) uploaded.push(banner);

      const resources = await uploadMediaFiles(
        resourceFiles,
        RESOURCE_FOLDER,
        files.resourceSeo ?? [],
      );
      uploaded.push(...resources);

      return await Blog.create({
        ...data,
        content: sanitizeBlogContent(data.content),
        ...(banner ? { banner } : {}),
        files: resources,
      });
    } catch (error) {
      await deleteMediaFilesQuietly(
        uploaded.map((file) => file.storageKey),
        'blog creation rollback',
      );
      throw error;
    }
  }

  async getBlogs(query: GetBlogsInput, options: { includeDrafts: boolean }) {
    const { page, limit, category, search, sortBy, sortOrder } = query;
    const filter: QueryFilter<IBlog> = {};

    // Anonymous readers only ever see published posts.
    if (!options.includeDrafts) filter.status = 'published';
    else if (query.status) filter.status = query.status;
    if (category) filter.category = category;
    if (search) filter.$text = { $search: search };

    const [blogs, total] = await Promise.all([
      Blog.find(filter)
        .sort({ [sortBy]: sortOrder === 'asc' ? 1 : -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      Blog.countDocuments(filter).exec(),
    ]);

    return {
      blogs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPrevPage: page > 1,
      },
    };
  }

  async getBlogById(id: string, options: { includeDrafts: boolean }): Promise<BlogDocument> {
    const blog = await Blog.findOne({
      _id: id,
      ...(options.includeDrafts ? {} : { status: 'published' }),
    }).exec();
    if (!blog) throw notFound();
    return blog;
  }

  /**
   * Exact, case-sensitive lookup: `gen-ai` matches, `Gen-ai` and `GEN-AI` do
   * not, so every post has exactly one canonical URL.
   */
  async getBlogBySlug(slug: string, options: { includeDrafts: boolean }): Promise<BlogDocument> {
    if (!BLOG_SLUG_PATTERN.test(slug)) throw notFound();
    const blog = await Blog.findOne({
      slug,
      ...(options.includeDrafts ? {} : { status: 'published' }),
    })
      .collation({ locale: 'simple' })
      .exec();
    if (!blog) throw notFound();
    return blog;
  }

  async updateBlog(
    id: string,
    data: UpdateBlogInput,
    files: BlogFileOptions = {},
  ): Promise<BlogDocument> {
    const existing = await Blog.findById(id).exec();
    if (!existing) throw notFound();

    if (data.slug && data.slug !== existing.slug) await assertUniqueSlug(data.slug, id);

    const existingFiles = existing.files.map(plainFile);
    const existingByKey = new Map(existingFiles.map((file) => [file.storageKey, file]));

    let retained = existingFiles;
    if (files.retainedFileStorageKeys !== undefined) {
      const requested = [...new Set(files.retainedFileStorageKeys)];
      const kept = requested.map((key) => existingByKey.get(key));
      if (kept.some((file) => !file)) {
        throw new AppError(
          'One or more retained resource files do not belong to this blog.',
          400,
          ErrorCode.VALIDATION_ERROR,
        );
      }
      retained = kept as UploadedFile[];
    }

    const resourceFiles = files.resourceFiles ?? [];
    assertResourceLimit(retained.length + resourceFiles.length);

    // SEO entries with a storageKey edit retained files; the rest describe new uploads in order.
    const resourceSeo = files.resourceSeo ?? [];
    const seoByKey = new Map(
      resourceSeo
        .filter((item) => item.storageKey?.trim())
        .map((item) => [item.storageKey!.trim(), item]),
    );
    const pendingSeo = resourceSeo.filter((item) => !item.storageKey?.trim());

    const newlyUploadedKeys: string[] = [];
    try {
      const updatedRetained = retained.map((file) =>
        updateMediaMetadata(file, seoByKey.get(file.storageKey)),
      );

      let nextBanner = existing.banner ? plainFile(existing.banner) : undefined;
      if (files.bannerFile) {
        nextBanner = await uploadMediaFile(files.bannerFile, BANNER_FOLDER, files.bannerSeo);
        newlyUploadedKeys.push(nextBanner.storageKey);
      } else if (files.removeBanner) {
        nextBanner = undefined;
      } else if (nextBanner && files.bannerSeo) {
        nextBanner = updateMediaMetadata(nextBanner, files.bannerSeo);
      }

      const uploadedResources = await uploadMediaFiles(resourceFiles, RESOURCE_FOLDER, pendingSeo);
      newlyUploadedKeys.push(...uploadedResources.map((file) => file.storageKey));

      const finalFiles = [...updatedRetained, ...uploadedResources];
      const updated = await Blog.findByIdAndUpdate(
        id,
        {
          $set: {
            ...data,
            ...(data.content !== undefined ? { content: sanitizeBlogContent(data.content) } : {}),
            files: finalFiles,
            ...(nextBanner ? { banner: nextBanner } : {}),
          },
          ...(!nextBanner && existing.banner ? { $unset: { banner: 1 } } : {}),
        },
        { returnDocument: 'after', runValidators: true },
      ).exec();
      if (!updated)
        throw new AppError('Blog was removed while it was being updated.', 409, ErrorCode.CONFLICT);

      // Only now that the database points at the new files, remove the replaced ones.
      const finalKeys = new Set(finalFiles.map((file) => file.storageKey));
      const oldBannerKey = existing.banner?.storageKey;
      await deleteMediaFilesQuietly(
        [
          ...existingFiles
            .filter((file) => !finalKeys.has(file.storageKey))
            .map((file) => file.storageKey),
          ...(oldBannerKey && oldBannerKey !== nextBanner?.storageKey ? [oldBannerKey] : []),
        ],
        'blog update cleanup',
      );

      return updated;
    } catch (error) {
      await deleteMediaFilesQuietly(newlyUploadedKeys, 'blog update rollback');
      throw error;
    }
  }

  async deleteBlog(id: string): Promise<BlogDocument> {
    const blog = await Blog.findByIdAndDelete(id).exec();
    if (!blog) throw notFound();
    await deleteMediaFilesQuietly(storageKeysOf(blog), 'blog deletion');
    return blog;
  }

  async deleteMultipleBlogs(ids: string[]) {
    const uniqueIds = [...new Set(ids)];
    const blogs = await Blog.find({ _id: { $in: uniqueIds } }).exec();
    const foundIds = new Set(blogs.map((blog) => String(blog._id)));

    const result = await Blog.deleteMany({ _id: { $in: [...foundIds] } }).exec();
    await deleteMediaFilesQuietly(blogs.flatMap(storageKeysOf), 'bulk blog deletion');

    return {
      deletedCount: result.deletedCount,
      failedIds: uniqueIds.filter((id) => !foundIds.has(id)),
    };
  }

  async updateBlogStatus(id: string, status: BlogStatus): Promise<BlogDocument> {
    const blog = await Blog.findByIdAndUpdate(
      id,
      { $set: { status } },
      { returnDocument: 'after', runValidators: true },
    ).exec();
    if (!blog) throw notFound();
    return blog;
  }

  async getBlogStats() {
    const [total, draft, published] = await Promise.all([
      Blog.countDocuments().exec(),
      Blog.countDocuments({ status: 'draft' }).exec(),
      Blog.countDocuments({ status: 'published' }).exec(),
    ]);
    return { total, draft, published };
  }
}

export const blogService = new BlogService();
