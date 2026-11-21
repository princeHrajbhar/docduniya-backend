import type { Request, Response } from 'express';
import { PERMISSIONS, hasPermission } from '../auth/index.js';
import { normalizeBlogMultipartBody } from './blog.multipart.js';
import { blogService, type BlogFileOptions } from './blog.service.js';
import {
  blogFileControlsSchema,
  createBlogSchema,
  updateBlogSchema,
  type GetBlogsInput,
} from './blog.validation.js';
import type { BlogStatus } from './blog.model.js';

type IdRequest = Request<{ id: string }>;
type BlogUploadFields = { banner?: Express.Multer.File[]; resources?: Express.Multer.File[] };

/** Staff with blogs.manage can read drafts through the public routes. */
const canSeeDrafts = (req: Request) => hasPermission(req, PERMISSIONS.BLOGS_MANAGE);

/** Parses the multipart form into validated data plus file controls and uploads. */
function readBlogForm(req: Request) {
  const normalized = normalizeBlogMultipartBody(req.body as Record<string, unknown> | undefined);
  const controls = blogFileControlsSchema.parse(normalized.controls);
  const uploads = req.files as BlogUploadFields | undefined;

  const files: BlogFileOptions = {
    bannerFile: uploads?.banner?.[0],
    resourceFiles: uploads?.resources ?? [],
    retainedFileStorageKeys: controls.retainedFileStorageKeys,
    removeBanner: controls.removeBanner,
    bannerSeo: controls.bannerSeo,
    resourceSeo: controls.resourceSeo,
  };
  return { data: normalized.data, files };
}

export async function createBlog(req: Request, res: Response) {
  const { data, files } = readBlogForm(req);
  const blog = await blogService.createBlog(createBlogSchema.parse(data), files);
  res.status(201).json({ success: true, message: 'Blog created successfully', data: blog });
}

export async function getBlogs(req: Request, res: Response) {
  const result = await blogService.getBlogs(req.query as unknown as GetBlogsInput, {
    includeDrafts: canSeeDrafts(req),
  });
  res.json({
    success: true,
    message: 'Blogs fetched successfully',
    data: result.blogs,
    pagination: result.pagination,
  });
}

export async function getBlogById(req: IdRequest, res: Response) {
  const blog = await blogService.getBlogById(req.params.id, { includeDrafts: canSeeDrafts(req) });
  res.json({ success: true, message: 'Blog fetched successfully', data: blog });
}

export async function getBlogBySlug(req: Request<{ slug: string }>, res: Response) {
  const blog = await blogService.getBlogBySlug(req.params.slug, {
    includeDrafts: canSeeDrafts(req),
  });
  res.json({ success: true, message: 'Blog fetched successfully', data: blog });
}

export async function updateBlog(req: IdRequest, res: Response) {
  const { data, files } = readBlogForm(req);
  const blog = await blogService.updateBlog(req.params.id, updateBlogSchema.parse(data), files);
  res.json({ success: true, message: 'Blog updated successfully', data: blog });
}

export async function deleteBlog(req: IdRequest, res: Response) {
  const blog = await blogService.deleteBlog(req.params.id);
  res.json({ success: true, message: 'Blog deleted successfully', data: blog });
}

export async function deleteMultipleBlogs(req: Request, res: Response) {
  const result = await blogService.deleteMultipleBlogs((req.body as { ids: string[] }).ids);
  res.json({ success: true, message: 'Blogs deleted successfully', data: result });
}

export async function updateBlogStatus(req: IdRequest, res: Response) {
  const blog = await blogService.updateBlogStatus(
    req.params.id,
    (req.body as { status: BlogStatus }).status,
  );
  res.json({ success: true, message: 'Blog status updated successfully', data: blog });
}

export async function getBlogStats(_req: Request, res: Response) {
  res.json({
    success: true,
    message: 'Blog statistics fetched successfully',
    data: await blogService.getBlogStats(),
  });
}
