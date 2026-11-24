import { Router, type Request } from 'express';
import { protect } from '../admin/auth/auth.middleware.js';
import { actor, idempotencyKey } from '../../shared/http/context.js';
import { idParam, ok } from '../../shared/http/handler.js';
import * as roles from './role-assignment.service.js';
import { roleAssignmentInput, roleRevocationInput } from './membership.validation.js';

const router = Router();
const org = '/organizations/:organizationId';
const orgId = (req: Request) => idParam(req, 'organizationId');

router.get(
  `${org}/memberships/:membershipId/role-assignments`,
  protect,
  ok((req) => roles.listRoleAssignments(actor(req), orgId(req), idParam(req, 'membershipId'))),
);
router.post(
  `${org}/memberships/:membershipId/role-assignments`,
  protect,
  ok(
    (req) =>
      roles.assignRole(
        actor(req),
        orgId(req),
        idParam(req, 'membershipId'),
        roleAssignmentInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.post(
  `${org}/role-assignments/:assignmentId/revoke`,
  protect,
  ok((req) =>
    roles.revokeRole(
      actor(req),
      orgId(req),
      idParam(req, 'assignmentId'),
      roleRevocationInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);

export default router;
