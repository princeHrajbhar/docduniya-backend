import { Router, type Request } from 'express';
import { protect } from '../admin/auth/auth.middleware.js';
import { actor, idempotencyKey } from '../../shared/http/context.js';
import { idParam, noStore, ok, pageQuery } from '../../shared/http/handler.js';
import * as diagnostics from './diagnostic.service.js';
import * as queries from './diagnostic-query.service.js';
import * as dto from './diagnostic.validation.js';

const router = Router();
const org = '/organizations/:organizationId';
const orgId = (req: Request) => idParam(req, 'organizationId');

router.get(
  '/diagnostic-tests',
  noStore(async (req) => diagnostics.listCatalogTests(dto.catalogQuery.parse(req.query))),
);
router.post(
  '/platform/diagnostic-tests',
  protect,
  ok(
    (req) =>
      diagnostics.addCatalogTest(
        actor(req),
        dto.testCatalogInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);

router.post(
  `${org}/encounters/:encounterId/service-orders`,
  protect,
  ok(
    (req) =>
      diagnostics.placeOrder(
        actor(req),
        orgId(req),
        idParam(req, 'encounterId'),
        dto.orderInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.post(
  `${org}/service-orders/:orderId/transition`,
  protect,
  ok((req) =>
    diagnostics.transitionOrder(
      actor(req),
      orgId(req),
      idParam(req, 'orderId'),
      dto.orderTransitionInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);
router.get(
  `${org}/lab-worklist`,
  protect,
  noStore((req) =>
    diagnostics.worklist(actor(req), orgId(req), dto.worklistQuery.parse(req.query)),
  ),
);
router.post(
  `${org}/specimens`,
  protect,
  ok(
    (req) =>
      diagnostics.collectSpecimen(
        actor(req),
        orgId(req),
        dto.specimenInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.post(
  `${org}/specimens/:specimenId/transition`,
  protect,
  ok((req) =>
    diagnostics.transitionSpecimen(
      actor(req),
      orgId(req),
      idParam(req, 'specimenId'),
      dto.specimenTransitionInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);
router.post(
  `${org}/diagnostic-reports`,
  protect,
  ok(
    (req) =>
      diagnostics.createReport(
        actor(req),
        orgId(req),
        dto.reportInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.get(
  `${org}/diagnostic-reports/:reportId`,
  protect,
  noStore((req) =>
    diagnostics.getReportForLab(actor(req), orgId(req), idParam(req, 'reportId'), pageQuery(req)),
  ),
);
router.post(
  `${org}/diagnostic-reports/:reportId/verify`,
  protect,
  ok((req) =>
    diagnostics.verifyReport(
      actor(req),
      orgId(req),
      idParam(req, 'reportId'),
      dto.verifyReportInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);
router.post(
  `${org}/diagnostic-reports/:reportId/amend`,
  protect,
  ok((req) =>
    diagnostics.amendReport(
      actor(req),
      orgId(req),
      idParam(req, 'reportId'),
      dto.amendReportInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);
router.post(
  `${org}/imaging-studies`,
  protect,
  ok(
    (req) =>
      diagnostics.registerImagingStudy(
        actor(req),
        orgId(req),
        dto.imagingStudyInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.get(
  `${org}/patients/:patientId/diagnostics`,
  protect,
  noStore((req) => queries.patientDiagnostics(actor(req), orgId(req), idParam(req, 'patientId'))),
);
router.get(
  '/patients/:patientId/diagnostic-reports',
  protect,
  noStore((req) => queries.patientReports(actor(req), idParam(req, 'patientId'))),
);

export default router;
