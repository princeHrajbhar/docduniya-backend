import { Router, type Request } from 'express';
import { protect } from '../admin/auth/auth.middleware.js';
import { actor, idempotencyKey } from '../../shared/http/context.js';
import { idParam, noStore, ok } from '../../shared/http/handler.js';
import * as intake from './intake.service.js';
import * as dto from './intake.validation.js';

const router = Router();
const org = '/organizations/:organizationId';
const orgId = (req: Request) => idParam(req, 'organizationId');
const expected = (req: Request) => dto.expectedVersionInput.parse(req.body).expectedVersion;

// Public: questions for a service, concern search and specialty routing.
router.get(
  '/offerings/:offeringId/questionnaire',
  noStore((req) => intake.offeringQuestionnaire(idParam(req, 'offeringId'))),
);
router.get(
  '/discovery/concerns',
  noStore((req) => intake.searchConcerns(dto.concernSearch.parse(req.query))),
);
router.post(
  '/discovery/route',
  noStore((req) => intake.routeConcerns(dto.routeInput.parse(req.body))),
);

// Patient intake for an appointment.
router.post(
  '/appointments/:appointmentId/intake',
  protect,
  ok(
    (req) =>
      intake.submitIntake(
        actor(req),
        idParam(req, 'appointmentId'),
        dto.intakeSubmission.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.get(
  '/appointments/:appointmentId/intake',
  protect,
  noStore((req) => intake.myIntake(actor(req), idParam(req, 'appointmentId'))),
);

// Provider questionnaires, assignment and review.
router.post(
  `${org}/questionnaires`,
  protect,
  ok(
    (req) =>
      intake.createQuestionnaire(
        actor(req),
        orgId(req),
        dto.questionnaireInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.get(
  `${org}/questionnaires`,
  protect,
  noStore((req) =>
    intake.listQuestionnaires(actor(req), orgId(req), dto.questionnaireQuery.parse(req.query)),
  ),
);
router.put(
  `${org}/questionnaires/:questionnaireId`,
  protect,
  ok((req) => {
    const body = dto.questionnaireDraftUpdate.parse(req.body);
    return intake.updateQuestionnaireDraft(
      actor(req),
      orgId(req),
      idParam(req, 'questionnaireId'),
      body.expectedVersion,
      body.questionnaire,
      idempotencyKey(req),
    );
  }),
);
for (const [path, target] of [
  ['publish', 'PUBLISHED'],
  ['retire', 'RETIRED'],
] as const)
  router.post(
    `${org}/questionnaires/:questionnaireId/${path}`,
    protect,
    ok((req) =>
      intake.changeQuestionnaireState(
        actor(req),
        orgId(req),
        idParam(req, 'questionnaireId'),
        expected(req),
        target,
        idempotencyKey(req),
      ),
    ),
  );
router.put(
  `${org}/offerings/:offeringId/questionnaire`,
  protect,
  ok((req) =>
    intake.assignQuestionnaire(
      actor(req),
      orgId(req),
      idParam(req, 'offeringId'),
      dto.assignmentInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);
router.get(
  `${org}/appointments/:appointmentId/intake`,
  protect,
  noStore((req) => intake.appointmentIntake(actor(req), orgId(req), idParam(req, 'appointmentId'))),
);
router.post(
  `${org}/intake-responses/:responseId/review`,
  protect,
  ok((req) =>
    intake.reviewIntake(
      actor(req),
      orgId(req),
      idParam(req, 'responseId'),
      expected(req),
      idempotencyKey(req),
    ),
  ),
);

// Platform templates and routing governance.
router.post(
  '/admin/questionnaires',
  protect,
  ok(
    (req) =>
      intake.createQuestionnaire(
        actor(req),
        undefined,
        dto.questionnaireInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.get(
  '/admin/questionnaires',
  protect,
  noStore((req) =>
    intake.listQuestionnaires(actor(req), undefined, dto.questionnaireQuery.parse(req.query)),
  ),
);
for (const [path, target] of [
  ['publish', 'PUBLISHED'],
  ['retire', 'RETIRED'],
] as const)
  router.post(
    `/admin/questionnaires/:questionnaireId/${path}`,
    protect,
    ok((req) =>
      intake.changeQuestionnaireState(
        actor(req),
        undefined,
        idParam(req, 'questionnaireId'),
        expected(req),
        target,
        idempotencyKey(req),
      ),
    ),
  );
router.post(
  '/admin/concern-mappings',
  protect,
  ok(
    (req) =>
      intake.proposeConcern(actor(req), dto.concernInput.parse(req.body), idempotencyKey(req)),
    201,
  ),
);
for (const [path, decision] of [
  ['approve', 'ACTIVE'],
  ['retire', 'RETIRED'],
] as const)
  router.post(
    `/admin/concern-mappings/:concernId/${path}`,
    protect,
    ok((req) =>
      intake.decideConcern(
        actor(req),
        idParam(req, 'concernId'),
        expected(req),
        decision,
        idempotencyKey(req),
      ),
    ),
  );

export default router;
