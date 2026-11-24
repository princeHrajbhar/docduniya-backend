import { Router, type Request } from 'express';
import { protect } from '../admin/auth/auth.middleware.js';
import { actor, idempotencyKey } from '../../shared/http/context.js';
import { idParam, noStore, ok } from '../../shared/http/handler.js';
import * as locations from '../locations/location.service.js';
import * as inpatient from './inpatient.service.js';
import * as dto from './inpatient.validation.js';

const router = Router();
const org = '/organizations/:organizationId';
const orgId = (req: Request) => idParam(req, 'organizationId');
const admissionId = (req: Request) => idParam(req, 'admissionId');

router.post(
  `${org}/locations`,
  protect,
  ok(
    (req) =>
      locations.createLocation(
        actor(req),
        orgId(req),
        locations.locationInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.get(
  `${org}/locations`,
  protect,
  noStore((req) =>
    locations.listLocations(actor(req), orgId(req), locations.locationQuery.parse(req.query)),
  ),
);
router.post(
  `${org}/locations/:locationId/state`,
  protect,
  ok((req) =>
    locations.changeLocationState(
      actor(req),
      orgId(req),
      idParam(req, 'locationId'),
      locations.locationStateInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);

router.post(
  `${org}/admissions`,
  protect,
  ok(
    (req) =>
      inpatient.requestAdmission(
        actor(req),
        orgId(req),
        dto.admissionInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.get(
  `${org}/admissions`,
  protect,
  noStore((req) => inpatient.census(actor(req), orgId(req), dto.censusQuery.parse(req.query))),
);
router.get(
  `${org}/bed-board`,
  protect,
  noStore((req) => inpatient.bedBoard(actor(req), orgId(req), dto.bedBoardQuery.parse(req.query))),
);
router.post(
  `${org}/admissions/:admissionId/admit`,
  protect,
  ok((req) =>
    inpatient.admit(
      actor(req),
      orgId(req),
      admissionId(req),
      dto.admitInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);
router.post(
  `${org}/admissions/:admissionId/transfer`,
  protect,
  ok((req) =>
    inpatient.transferBed(
      actor(req),
      orgId(req),
      admissionId(req),
      dto.transferInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);
router.post(
  `${org}/admissions/:admissionId/cancel`,
  protect,
  ok((req) =>
    inpatient.cancelAdmission(
      actor(req),
      orgId(req),
      admissionId(req),
      dto.cancelAdmissionInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);
router.get(
  `${org}/admissions/:admissionId/nursing-chart`,
  protect,
  noStore((req) => inpatient.nursingChart(actor(req), orgId(req), admissionId(req))),
);
router.post(
  `${org}/admissions/:admissionId/medication-administrations`,
  protect,
  ok(
    (req) =>
      inpatient.recordAdministration(
        actor(req),
        orgId(req),
        admissionId(req),
        dto.administrationInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.post(
  `${org}/medication-administrations/:administrationId/correct`,
  protect,
  ok(
    (req) =>
      inpatient.correctAdministration(
        actor(req),
        orgId(req),
        idParam(req, 'administrationId'),
        dto.administrationCorrectionInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.post(
  `${org}/admissions/:admissionId/fluid-balance`,
  protect,
  ok(
    (req) =>
      inpatient.recordFluid(
        actor(req),
        orgId(req),
        admissionId(req),
        dto.fluidInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.post(
  `${org}/admissions/:admissionId/observations`,
  protect,
  ok(
    (req) =>
      inpatient.recordInpatientObservation(
        actor(req),
        orgId(req),
        admissionId(req),
        dto.inpatientObservationInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.post(
  `${org}/admissions/:admissionId/discharge-plan`,
  protect,
  ok(
    (req) =>
      inpatient.createDischargePlan(
        actor(req),
        orgId(req),
        admissionId(req),
        dto.dischargePlanInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.post(
  `${org}/discharge-plans/:planId/checklist`,
  protect,
  ok((req) =>
    inpatient.updateChecklist(
      actor(req),
      orgId(req),
      idParam(req, 'planId'),
      dto.checklistUpdateInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);
router.post(
  `${org}/admissions/:admissionId/clinical-discharge`,
  protect,
  ok((req) =>
    inpatient.clinicalDischarge(
      actor(req),
      orgId(req),
      admissionId(req),
      dto.dischargeInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);
router.post(
  `${org}/admissions/:admissionId/depart`,
  protect,
  ok((req) =>
    inpatient.depart(
      actor(req),
      orgId(req),
      admissionId(req),
      dto.departInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);

export default router;
