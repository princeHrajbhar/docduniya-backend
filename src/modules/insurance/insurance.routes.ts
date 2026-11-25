import { Router, type Request } from 'express';
import { protect } from '../admin/auth/auth.middleware.js';
import { actor, idempotencyKey } from '../../shared/http/context.js';
import { idParam, noStore, ok } from '../../shared/http/handler.js';
import * as insurance from './insurance.service.js';

const router = Router();
const org = '/organizations/:organizationId';
const orgId = (req: Request) => idParam(req, 'organizationId');

router.get(
  '/payers',
  noStore(() => insurance.listPayers()),
);
router.post(
  '/admin/payers',
  protect,
  ok(
    (req) =>
      insurance.createPayer(actor(req), insurance.payerInput.parse(req.body), idempotencyKey(req)),
    201,
  ),
);
router.post(
  '/patients/:patientId/coverages',
  protect,
  ok(
    (req) =>
      insurance.addCoverage(
        actor(req),
        idParam(req, 'patientId'),
        insurance.coverageInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.get(
  '/patients/:patientId/coverages',
  protect,
  noStore((req) => insurance.patientCoverages(actor(req), idParam(req, 'patientId'))),
);
router.post(
  `${org}/patients/:patientId/coverages`,
  protect,
  ok(
    (req) =>
      insurance.addCoverage(
        actor(req),
        idParam(req, 'patientId'),
        insurance.coverageInput.parse(req.body),
        idempotencyKey(req),
        orgId(req),
      ),
    201,
  ),
);
router.post(
  `${org}/preauthorizations`,
  protect,
  ok(
    (req) =>
      insurance.requestPreauthorization(
        actor(req),
        orgId(req),
        insurance.preauthInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.post(
  `${org}/preauthorizations/:preauthId/decision`,
  protect,
  ok((req) =>
    insurance.recordPreauthDecision(
      actor(req),
      orgId(req),
      idParam(req, 'preauthId'),
      insurance.payerDecisionInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);
router.post(
  `${org}/claims`,
  protect,
  ok(
    (req) =>
      insurance.submitClaim(
        actor(req),
        orgId(req),
        insurance.claimInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.get(
  `${org}/claims`,
  protect,
  noStore((req) =>
    insurance.listClaims(actor(req), orgId(req), insurance.claimQuery.parse(req.query)),
  ),
);
router.post(
  `${org}/claims/:claimId/adjudication`,
  protect,
  ok((req) =>
    insurance.adjudicateClaim(
      actor(req),
      orgId(req),
      idParam(req, 'claimId'),
      insurance.payerDecisionInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);
router.post(
  `${org}/claims/:claimId/settlement`,
  protect,
  ok((req) =>
    insurance.settleClaim(
      actor(req),
      orgId(req),
      idParam(req, 'claimId'),
      insurance.settlementInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);
router.post(
  `${org}/claims/:claimId/withdrawal`,
  protect,
  ok((req) =>
    insurance.withdrawClaim(
      actor(req),
      orgId(req),
      idParam(req, 'claimId'),
      insurance.withdrawInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);

export default router;
