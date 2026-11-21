import { Router } from 'express';
import { validate } from '../../../middlewares/validate.js';
import { PERMISSIONS, protect, requirePermission } from '../auth/index.js';
import * as controller from './blog-category.controller.js';
import {
  blogCategoryIdParamsSchema,
  blogCategorySlugParamsSchema,
  createBlogCategorySchema,
  updateBlogCategorySchema,
} from './blog-category.validation.js';

const router = Router();
const manage = [protect, requirePermission(PERMISSIONS.BLOG_CATEGORIES_MANAGE)];
const idParams = validate({ params: blogCategoryIdParamsSchema });

// ── Public ──────────────────────────────────────────────────────────────────
router.get('/', controller.getCategories);
router.get(
  '/slug/:slug',
  validate({ params: blogCategorySlugParamsSchema }),
  controller.getCategoryBySlug,
);
router.get('/:id', idParams, controller.getCategoryById);

// ── Admin ───────────────────────────────────────────────────────────────────
router.post(
  '/',
  ...manage,
  validate({ body: createBlogCategorySchema }),
  controller.createCategory,
);
router.put(
  '/:id',
  ...manage,
  idParams,
  validate({ body: updateBlogCategorySchema }),
  controller.updateCategory,
);
router.patch(
  '/:id',
  ...manage,
  idParams,
  validate({ body: updateBlogCategorySchema }),
  controller.updateCategory,
);
router.delete('/:id', ...manage, idParams, controller.deleteCategory);

export default router;
