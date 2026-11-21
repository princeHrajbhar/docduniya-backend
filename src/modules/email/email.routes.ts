import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { protect, requirePermission } from '../admin/auth/auth.middleware.js';
import { PERMISSIONS } from '../admin/auth/roles/permission.constants.js';
import * as controller from './email.controller.js';
import {
  blockEmailSchema,
  emailLogQuerySchema,
  emailParamsSchema,
  suppressionListSchema,
} from './email.validation.js';

const router = Router();

router.use(protect, requirePermission(PERMISSIONS.EMAIL_MANAGE));

router.get(
  '/suppressions',
  validate({ query: suppressionListSchema }),
  controller.listSuppressions,
);
router.post('/suppressions', validate({ body: blockEmailSchema }), controller.blockEmail);
router.delete(
  '/suppressions/:email',
  validate({ params: emailParamsSchema }),
  controller.unblockEmail,
);
router.get('/logs', validate({ query: emailLogQuerySchema }), controller.listEmailLogs);

export default router;
