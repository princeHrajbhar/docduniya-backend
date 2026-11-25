import { Router } from 'express';
import { protect } from '../admin/auth/auth.middleware.js';
import { actor, idempotencyKey } from '../../shared/http/context.js';
import { idParam, noStore, ok } from '../../shared/http/handler.js';
import * as merge from './merge.service.js';

/** Duplicate patient identity reconciliation. */
const router = Router();

router.post(
  '/patients/merge-requests',
  protect,
  ok(
    (req) =>
      merge.requestMerge(actor(req), merge.mergeRequestInput.parse(req.body), idempotencyKey(req)),
    201,
  ),
);
router.post(
  '/organizations/:organizationId/patient-merge-requests',
  protect,
  ok(
    (req) =>
      merge.requestMerge(
        actor(req),
        merge.mergeRequestInput.parse(req.body),
        idempotencyKey(req),
        idParam(req, 'organizationId'),
      ),
    201,
  ),
);
router.get(
  '/admin/patient-merge-requests',
  protect,
  noStore((req) => merge.listMergeCases(actor(req), merge.mergeQuery.parse(req.query))),
);
router.post(
  '/admin/patient-merge-requests/:caseId/decision',
  protect,
  ok((req) =>
    merge.decideMerge(
      actor(req),
      idParam(req, 'caseId'),
      merge.mergeDecisionInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);

export default router;
