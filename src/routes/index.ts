import { Router } from 'express';
import healthRoutes from './health.routes.js';
import { authRoutes, roleRoutes } from '../modules/admin/auth/index.js';
import { userRoutes } from '../modules/users/index.js';
import { managedFileRoutes } from '../modules/managed-files/index.js';
import { assetRoutes } from '../modules/assets/index.js';
import emailRoutes from '../modules/email/email.routes.js';
import { blogRoutes } from '../modules/admin/blog/index.js';
import { blogCategoryRoutes } from '../modules/admin/blogCategories/index.js';
import healthcareRoutes from './healthcare.routes.js';
import providerRoutes from '../modules/providers/provider.routes.js';
import bookingRoutes from '../modules/appointments/booking.routes.js';
import billingRoutes from '../modules/billing/billing.routes.js';
import accessRoutes from '../modules/access/access.routes.js';
import clinicalRoutes from '../modules/clinical/clinical.routes.js';
import diagnosticRoutes from '../modules/diagnostics/diagnostic.routes.js';
import documentRoutes from '../modules/documents/document.routes.js';
import privacyRoutes from '../modules/privacy/privacy.routes.js';
import inpatientRoutes from '../modules/inpatient/inpatient.routes.js';
import pharmacyRoutes from '../modules/pharmacy/pharmacy.routes.js';
import engagementRoutes from '../modules/engagement/engagement.routes.js';

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
router.use(providerRoutes);
// Public review listings live under /doctors and must be matched before the protected doctor router.
router.use(engagementRoutes);
router.use(bookingRoutes);
router.use(billingRoutes);
router.use(accessRoutes);
router.use(clinicalRoutes);
router.use(diagnosticRoutes);
router.use(documentRoutes);
router.use(privacyRoutes);
router.use(inpatientRoutes);
router.use(pharmacyRoutes);
router.use(healthcareRoutes);

export default router;
