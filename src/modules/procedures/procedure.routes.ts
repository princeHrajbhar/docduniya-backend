import { Router, type Request } from 'express';
import { z } from 'zod';
import { protect } from '../admin/auth/auth.middleware.js';
import { actor, idempotencyKey } from '../../shared/http/context.js';
import { idParam, noStore, ok } from '../../shared/http/handler.js';
import * as procedures from './procedure.service.js';

const router = Router();
const org = '/organizations/:organizationId';
const orgId = (req: Request) => idParam(req, 'organizationId');
const caseId = (req: Request) => idParam(req, 'caseId');
const expected = (req: Request) =>
  z.strictObject({ expectedVersion: z.number().int().min(0) }).parse(req.body).expectedVersion;

router.post(
  `${org}/procedures`,
  protect,
  ok(
    (req) =>
      procedures.requestProcedure(
        actor(req),
        orgId(req),
        procedures.procedureRequestInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.get(
  `${org}/theatre-schedule`,
  protect,
  noStore((req) =>
    procedures.theatreSchedule(actor(req), orgId(req), procedures.theatreQuery.parse(req.query)),
  ),
);
router.get(
  `${org}/procedures/:caseId`,
  protect,
  noStore((req) => procedures.getProcedure(actor(req), orgId(req), caseId(req))),
);
router.post(
  `${org}/procedures/:caseId/schedule`,
  protect,
  ok((req) =>
    procedures.scheduleProcedure(
      actor(req),
      orgId(req),
      caseId(req),
      procedures.scheduleInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);
for (const [path, phase] of [
  ['sign-in', 'SIGN_IN'],
  ['time-out', 'TIME_OUT'],
  ['sign-out', 'SIGN_OUT'],
] as const)
  router.post(
    `${org}/procedures/:caseId/checklist/${path}`,
    protect,
    ok((req) =>
      procedures.completeChecklist(
        actor(req),
        orgId(req),
        caseId(req),
        phase,
        procedures.checklistInput.parse(req.body),
        idempotencyKey(req),
      ),
    ),
  );
router.post(
  `${org}/procedures/:caseId/start`,
  protect,
  ok((req) =>
    procedures.startProcedure(
      actor(req),
      orgId(req),
      caseId(req),
      expected(req),
      idempotencyKey(req),
    ),
  ),
);
router.post(
  `${org}/procedures/:caseId/complete`,
  protect,
  ok((req) =>
    procedures.completeProcedure(
      actor(req),
      orgId(req),
      caseId(req),
      procedures.completionInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);
router.post(
  `${org}/procedures/:caseId/cancel`,
  protect,
  ok((req) =>
    procedures.cancelProcedure(
      actor(req),
      orgId(req),
      caseId(req),
      procedures.cancelProcedureInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);

export default router;
