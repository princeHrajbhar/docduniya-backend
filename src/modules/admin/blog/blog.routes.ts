import { Router } from 'express';
import { uploadLimiter } from '../../../middlewares/rate-limit.js';
import { validate } from '../../../middlewares/validate.js';
import { AppError, ErrorCode } from '../../../utils/app-error.js';
import { PERMISSIONS, optionalAuth, protect, requirePermission } from '../auth/index.js';
import {
  createUploadFields,
  DOCUMENT_MIME_TYPES,
  IMAGE_MIME_TYPES,
  VIDEO_MIME_TYPES,
} from '../../file-manager/index.js';
import * as controller from './blog.controller.js';
import { MAX_BLOG_RESOURCES } from './blog.model.js';
import {
  blogIdParamsSchema,
  blogSlugParamsSchema,
  bulkDeleteBlogsSchema,
  getBlogsSchema,
  updateBlogStatusSchema,
} from './blog.validation.js';

const router = Router();

const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif'];

/** Banner: one image. Resources: images, videos and documents. 25 MB per file. */
const blogUpload = createUploadFields({
  maxFileSizeBytes: 25 * 1024 * 1024,
  maxFiles: MAX_BLOG_RESOURCES + 1,
  fields: [
    { name: 'banner', maxCount: 1, mimeTypes: IMAGE_MIME_TYPES, extensions: IMAGE_EXTENSIONS },
    {
      name: 'resources',
      maxCount: MAX_BLOG_RESOURCES,
      mimeTypes: [...IMAGE_MIME_TYPES, ...VIDEO_MIME_TYPES, ...DOCUMENT_MIME_TYPES],
      extensions: [
        ...IMAGE_EXTENSIONS,
        'mp4',
        'webm',
        'mov',
        'avi',
        'mkv',
        'pdf',
        'doc',
        'docx',
        'txt',
      ],
    },
  ],
});

const manage = [protect, requirePermission(PERMISSIONS.BLOGS_MANAGE)];
const idParams = validate({ params: blogIdParamsSchema });

// ── Public (published posts only; drafts too for signed-in blog managers) ──
router.get('/', optionalAuth, validate({ query: getBlogsSchema }), controller.getBlogs);
router.get('/stats', ...manage, controller.getBlogStats);
router.get(
  '/slug/:slug',
  optionalAuth,
  // A malformed or non-canonical slug is simply "not found".
  (req, _res, next) =>
    next(
      blogSlugParamsSchema.safeParse(req.params).success
        ? undefined
        : new AppError('Blog not found', 404, ErrorCode.NOT_FOUND),
    ),
  controller.getBlogBySlug,
);
router.get('/:id', optionalAuth, idParams, controller.getBlogById);

// ── Admin ──────────────────────────────────────────────────────────────────
// Multipart bodies are validated in the controller after multer has parsed them.
router.post('/', ...manage, uploadLimiter, blogUpload, controller.createBlog);
router.post(
  '/bulk-delete',
  ...manage,
  validate({ body: bulkDeleteBlogsSchema }),
  controller.deleteMultipleBlogs,
);
router.put('/:id', ...manage, idParams, uploadLimiter, blogUpload, controller.updateBlog);
router.patch('/:id', ...manage, idParams, uploadLimiter, blogUpload, controller.updateBlog);
router.patch(
  '/:id/status',
  ...manage,
  idParams,
  validate({ body: updateBlogStatusSchema }),
  controller.updateBlogStatus,
);
router.delete('/:id', ...manage, idParams, controller.deleteBlog);

export default router;
