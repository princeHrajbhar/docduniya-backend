import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { PERMISSIONS, protect, requirePermission } from '../admin/auth/index.js';
import * as controller from './user.controller.js';
import {
  createUserSchema,
  emailParamsSchema,
  emailPreferenceSchema,
  updateUserSchema,
  userIdParamsSchema,
  userQuerySchema,
  userSessionParamsSchema,
  verificationSchema,
} from './user.validation.js';

const router = Router();
const idParams = validate({ params: userIdParamsSchema });

// Every route in this module is admin-only.
router.use(protect, requirePermission(PERMISSIONS.USERS_MANAGE));

router.post('/', validate({ body: createUserSchema }), controller.createUser);
router.get('/', validate({ query: userQuerySchema }), controller.getUsers);
router.get('/export', validate({ query: userQuerySchema }), controller.exportUsers);
router.get(
  '/lock-status/:email',
  validate({ params: emailParamsSchema }),
  controller.checkLockStatus,
);

router.patch(
  '/:id/verify',
  idParams,
  validate({ body: verificationSchema }),
  controller.setVerification,
);
router.patch('/:id/unlock', idParams, controller.unlockUser);
router.get('/:id/email-preference', idParams, controller.getUserEmailPreference);
router.patch(
  '/:id/email-preference',
  idParams,
  validate({ body: emailPreferenceSchema }),
  controller.setUserEmailPreference,
);
router.get('/:id/sessions', idParams, controller.getUserSessions);
router.delete('/:id/sessions', idParams, controller.revokeAllUserSessions);
router.delete(
  '/:id/sessions/:sessionId',
  validate({ params: userSessionParamsSchema }),
  controller.revokeUserSession,
);

router.get('/:id', idParams, controller.getUserById);
router.patch('/:id', idParams, validate({ body: updateUserSchema }), controller.updateUser);
// PUT is kept for clients that send full updates; it behaves like PATCH.
router.put('/:id', idParams, validate({ body: updateUserSchema }), controller.updateUser);
router.delete('/:id', idParams, controller.deleteUser);

export default router;
