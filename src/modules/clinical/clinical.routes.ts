import { Router, type Request } from 'express';
import { protect } from '../admin/auth/auth.middleware.js';
import { actor, idempotencyKey, param } from '../../shared/http/context.js';
import { idParam, noStore, ok, pageQuery } from '../../shared/http/handler.js';
import { ApiError } from '../../utils/api-error.js';
import * as encounters from './encounter.service.js';
import * as records from './record.service.js';
import * as queries from './clinical-query.service.js';
import * as tasks from './task.service.js';
import * as dto from './clinical.validation.js';

const router = Router();
const org = '/organizations/:organizationId';
const orgId = (req: Request) => idParam(req, 'organizationId');
const patientId = (req: Request) => idParam(req, 'patientId');
const FACTS = {
  allergies: { type: 'allergy', input: dto.allergyInput },
  conditions: { type: 'condition', input: dto.conditionInput },
  'medication-statements': { type: 'medicationStatement', input: dto.medicationStatementInput },
  immunizations: { type: 'immunization', input: dto.immunizationInput },
} as const;
const signType = (req: Request) => {
  const type = dto.signableType.parse(param(req, 'type'));
  if (!records.isSignType(type))
    throw ApiError.badRequest('This record type is not signed through this command');
  return type;
};

// Encounters, visits and care teams
router.post(
  `${org}/encounters`,
  protect,
  ok(
    (req) =>
      encounters.startEncounter(
        actor(req),
        orgId(req),
        dto.encounterInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.get(
  `${org}/encounters`,
  protect,
  noStore((req) =>
    encounters.listEncounters(actor(req), orgId(req), dto.encounterQuery.parse(req.query)),
  ),
);
router.get(
  `${org}/encounters/:encounterId`,
  protect,
  noStore((req) => encounters.getEncounter(actor(req), orgId(req), idParam(req, 'encounterId'))),
);
router.post(
  `${org}/encounters/:encounterId/finish`,
  protect,
  ok((req) =>
    encounters.finishEncounter(
      actor(req),
      orgId(req),
      idParam(req, 'encounterId'),
      dto.expectedVersionInput.parse(req.body).expectedVersion,
      idempotencyKey(req),
    ),
  ),
);
router.post(
  `${org}/visits/:visitId/close`,
  protect,
  ok((req) =>
    encounters.closeVisit(
      actor(req),
      orgId(req),
      idParam(req, 'visitId'),
      dto.expectedVersionInput.parse(req.body).expectedVersion,
      idempotencyKey(req),
    ),
  ),
);
router.post(
  `${org}/patients/:patientId/care-team`,
  protect,
  ok(
    (req) =>
      encounters.assignCareTeam(
        actor(req),
        orgId(req),
        patientId(req),
        dto.careTeamInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.post(
  `${org}/care-team/:assignmentId/end`,
  protect,
  ok((req) =>
    encounters.endCareTeam(
      actor(req),
      orgId(req),
      idParam(req, 'assignmentId'),
      dto.endCareInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);

// Encounter documentation
router.post(
  `${org}/encounters/:encounterId/notes`,
  protect,
  ok(
    (req) =>
      records.createNote(
        actor(req),
        orgId(req),
        idParam(req, 'encounterId'),
        dto.noteInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.post(
  `${org}/encounters/:encounterId/diagnoses`,
  protect,
  ok(
    (req) =>
      records.createDiagnosis(
        actor(req),
        orgId(req),
        idParam(req, 'encounterId'),
        dto.diagnosisInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.post(
  `${org}/encounters/:encounterId/observations`,
  protect,
  ok(
    (req) =>
      records.recordObservation(
        actor(req),
        orgId(req),
        idParam(req, 'encounterId'),
        dto.observationInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.post(
  `${org}/encounters/:encounterId/prescriptions`,
  protect,
  ok(
    (req) =>
      records.createPrescription(
        actor(req),
        orgId(req),
        idParam(req, 'encounterId'),
        dto.prescriptionInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.post(
  `${org}/encounters/:encounterId/referrals`,
  protect,
  ok(
    (req) =>
      tasks.createReferral(
        actor(req),
        orgId(req),
        idParam(req, 'encounterId'),
        dto.referralInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.post(
  `${org}/clinical-notes/:noteId/draft`,
  protect,
  ok((req) =>
    records.updateNote(
      actor(req),
      orgId(req),
      idParam(req, 'noteId'),
      dto.noteUpdateInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);
router.post(
  `${org}/clinical-notes/:noteId/amend`,
  protect,
  ok((req) =>
    records.amendNote(
      actor(req),
      orgId(req),
      idParam(req, 'noteId'),
      dto.amendInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);
router.post(
  `${org}/clinical-notes/:noteId/addenda`,
  protect,
  ok(
    (req) =>
      records.addAddendum(
        actor(req),
        orgId(req),
        idParam(req, 'noteId'),
        dto.addendumInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.post(
  `${org}/clinical-notes/:noteId/release`,
  protect,
  ok((req) =>
    records.releaseNote(
      actor(req),
      orgId(req),
      idParam(req, 'noteId'),
      dto.expectedVersionInput.parse(req.body).expectedVersion,
      idempotencyKey(req),
    ),
  ),
);
router.get(
  `${org}/prescriptions/:prescriptionId`,
  protect,
  noStore((req) => queries.getPrescription(actor(req), orgId(req), idParam(req, 'prescriptionId'))),
);
router.post(
  `${org}/prescription-items/:itemId/stop`,
  protect,
  ok((req) =>
    records.stopPrescriptionItem(
      actor(req),
      orgId(req),
      idParam(req, 'itemId'),
      dto.stopItemInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);

// Signing, corrections and revision history (allowlisted resource types only)
router.post(
  `${org}/clinical-records/:type/:id/sign`,
  protect,
  ok((req) =>
    records.signRecord(
      actor(req),
      orgId(req),
      signType(req),
      idParam(req, 'id'),
      dto.signInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);
router.post(
  `${org}/clinical-records/:type/:id/mark-error`,
  protect,
  ok((req) =>
    records.markEnteredInError(
      actor(req),
      orgId(req),
      dto.signableType.parse(param(req, 'type')),
      idParam(req, 'id'),
      dto.markErrorInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);
router.get(
  `${org}/clinical-records/:type/:id/revisions`,
  protect,
  noStore((req) =>
    queries.getRevisions(
      actor(req),
      orgId(req),
      dto.signableType.parse(param(req, 'type')),
      idParam(req, 'id'),
    ),
  ),
);

// Longitudinal facts
for (const [path, fact] of Object.entries(FACTS)) {
  router.post(
    `${org}/patients/:patientId/${path}`,
    protect,
    ok(
      (req) =>
        records.recordFact(
          actor(req),
          orgId(req),
          patientId(req),
          fact.type,
          fact.input.parse(req.body),
          idempotencyKey(req),
        ),
      201,
    ),
  );
  router.post(
    `${org}/${path}/:id/update`,
    protect,
    ok((req) => {
      const body = dto.factUpdateInput(fact.input as never).parse(req.body) as {
        expectedVersion: number;
        reason: string;
        record: unknown;
      };
      return records.updateFact(
        actor(req),
        orgId(req),
        fact.type,
        idParam(req, 'id'),
        body.expectedVersion,
        body.reason,
        fact.input.parse(body.record),
        idempotencyKey(req),
      );
    }),
  );
}

// Chart views
router.get(
  `${org}/patients/:patientId/clinical-summary`,
  protect,
  noStore((req) => queries.clinicalSummary(actor(req), orgId(req), patientId(req))),
);
router.get(
  `${org}/patients/:patientId/timeline`,
  protect,
  noStore((req) => queries.clinicalTimeline(actor(req), orgId(req), patientId(req))),
);
router.get(
  `${org}/patients/:patientId/shared-records`,
  protect,
  noStore((req) =>
    queries.sharedRecords(
      actor(req),
      orgId(req),
      patientId(req),
      dto.sharedRecordsQuery.parse(req.query),
    ),
  ),
);

// Tasks and referrals
router.post(
  `${org}/tasks`,
  protect,
  ok(
    (req) =>
      tasks.createTask(actor(req), orgId(req), dto.taskInput.parse(req.body), idempotencyKey(req)),
    201,
  ),
);
router.get(
  `${org}/tasks`,
  protect,
  noStore((req) => tasks.listTasks(actor(req), orgId(req), dto.taskQuery.parse(req.query))),
);
router.post(
  `${org}/tasks/:taskId/transition`,
  protect,
  ok((req) =>
    tasks.transitionTask(
      actor(req),
      orgId(req),
      idParam(req, 'taskId'),
      dto.taskTransitionInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);
router.get(
  `${org}/referrals/incoming`,
  protect,
  noStore((req) => tasks.listIncomingReferrals(actor(req), orgId(req), pageQuery(req))),
);
router.post(
  `${org}/referrals/:referralId/respond`,
  protect,
  ok((req) =>
    tasks.respondToReferral(
      actor(req),
      orgId(req),
      idParam(req, 'referralId'),
      dto.referralResponseInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);

// Patient portal
router.get(
  '/patients/:patientId/clinical-records',
  protect,
  noStore((req) => queries.patientRecords(actor(req), patientId(req))),
);

export default router;
