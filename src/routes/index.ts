import { Router } from 'express';
import healthRoutes from './health.routes.js';
import { authRoutes, roleRoutes } from '../modules/admin/auth/index.js';
import { userRoutes } from '../modules/users/index.js';
import { managedFileRoutes } from '../modules/managed-files/index.js';
import { assetRoutes } from '../modules/assets/index.js';
import emailRoutes from '../modules/email/email.routes.js';
import { blogRoutes } from '../modules/admin/blog/index.js';
import { blogCategoryRoutes } from '../modules/admin/blogCategories/index.js';

const router = Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/roles', roleRoutes);
router.use('/users', userRoutes);
router.use('/files', managedFileRoutes);
router.use('/assets', assetRoutes);
router.use('/email', emailRoutes);
router.use('/blogs', blogRoutes);
router.use('/blog-categories', blogCategoryRoutes);

export default router;
