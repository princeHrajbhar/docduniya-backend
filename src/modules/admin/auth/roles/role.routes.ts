import { Router } from 'express';
import { validate } from '../../../../middlewares/validate.js';
import { protect, requirePermission } from '../auth.middleware.js';
import { PERMISSIONS } from './permission.constants.js';
import * as controller from './role.controller.js';
import { createRoleSchema, roleIdParamsSchema, updateRoleSchema } from './role.validation.js';

const router = Router();

// Needed by the user-management screen to populate the role picker.
router.get(
  '/assignable',
  protect,
  requirePermission(PERMISSIONS.USERS_MANAGE),
  controller.listAssignableRoles,
);

router.use(protect, requirePermission(PERMISSIONS.ROLES_MANAGE));
router.get('/', controller.listRoles);
router.get('/permissions', controller.getPermissionCatalog);
router.post('/', validate({ body: createRoleSchema }), controller.createRole);
router.patch(
  '/:id',
  validate({ params: roleIdParamsSchema, body: updateRoleSchema }),
  controller.updateRole,
);
router.delete('/:id', validate({ params: roleIdParamsSchema }), controller.deleteRole);

export default router;
