import { Router, type Request } from 'express';
import { protect } from '../admin/auth/auth.middleware.js';
import { actor, idempotencyKey } from '../../shared/http/context.js';
import { idParam, noStore, ok, pageQuery } from '../../shared/http/handler.js';
import * as privacy from './privacy.service.js';
import * as dto from './privacy.validation.js';

const router = Router();
const patientId = (req: Request) => idParam(req, 'patientId');
const orgId = (req: Request) => idParam(req, 'organizationId');

router.get(
  '/policies',
  noStore(async (req) =>
    privacy.currentPolicies(
      typeof req.query.language === 'string' ? req.query.language.slice(0, 10) : 'en',
    ),
  ),
);
router.post(
  '/platform/policies',
  protect,
  ok(
    (req) =>
      privacy.publishPolicy(actor(req), dto.policyInput.parse(req.body), idempotencyKey(req)),
    201,
  ),
);
router.post(
  '/me/policy-acknowledgements',
  protect,
  ok((req) => privacy.acknowledgePolicy(actor(req), dto.acknowledgementInput.parse(req.body)), 201),
);

router.post(
  '/patients/:patientId/consents/record-sharing',
  protect,
  ok(
    (req) =>
      privacy.grantRecordSharing(
        actor(req),
        patientId(req),
        dto.sharingConsentInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.get(
  '/patients/:patientId/consents',
  protect,
  noStore((req) =>
    privacy.listPatientConsents(actor(req), patientId(req), dto.consentQuery.parse(req.query)),
  ),
);
router.post(
  '/consents/:consentId/withdraw',
  protect,
  ok((req) =>
    privacy.withdrawConsent(
      actor(req),
      idParam(req, 'consentId'),
      dto.withdrawInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);
router.post(
  '/organizations/:organizationId/consents',
  protect,
  ok(
    (req) =>
      privacy.recordProviderConsent(
        actor(req),
        orgId(req),
        dto.providerConsentInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);

router.post(
  '/organizations/:organizationId/patients/:patientId/emergency-access',
  protect,
  ok(
    (req) =>
      privacy.emergencyAccess(
        actor(req),
        orgId(req),
        patientId(req),
        dto.emergencyAccessInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.get(
  '/organizations/:organizationId/emergency-access',
  protect,
  noStore((req) => privacy.listEmergencyAccess(actor(req), orgId(req), pageQuery(req))),
);
router.post(
  '/organizations/:organizationId/emergency-access/:grantId/review',
  protect,
  ok((req) =>
    privacy.reviewEmergencyAccess(
      actor(req),
      orgId(req),
      idParam(req, 'grantId'),
      dto.emergencyReviewInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);

router.post(
  '/patients/:patientId/privacy-requests',
  protect,
  ok(
    (req) =>
      privacy.createPrivacyRequest(
        actor(req),
        patientId(req),
        dto.privacyRequestInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.get(
  '/patients/:patientId/privacy-requests',
  protect,
  noStore((req) => privacy.listPrivacyRequests(actor(req), pageQuery(req), patientId(req))),
);
router.get(
  '/patients/:patientId/export',
  protect,
  noStore((req) => privacy.exportPatientData(actor(req), patientId(req))),
);
router.get(
  '/patients/:patientId/access-history',
  protect,
  noStore((req) => privacy.patientAccessHistory(actor(req), patientId(req), pageQuery(req))),
);
router.get(
  '/platform/privacy-requests',
  protect,
  noStore((req) => privacy.listPrivacyRequests(actor(req), pageQuery(req))),
);
router.post(
  '/platform/privacy-requests/:requestId/decide',
  protect,
  ok((req) =>
    privacy.decidePrivacyRequest(
      actor(req),
      idParam(req, 'requestId'),
      dto.privacyDecisionInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);
router.post(
  '/platform/retention-holds',
  protect,
  ok(
    (req) =>
      privacy.placeRetentionHold(
        actor(req),
        dto.retentionHoldInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);

router.get(
  '/organizations/:organizationId/audit-events',
  protect,
  noStore((req) =>
    privacy.organizationAudit(actor(req), orgId(req), dto.auditQuery.parse(req.query)),
  ),
);
router.get(
  '/platform/audit-events',
  protect,
  noStore((req) => privacy.platformAudit(actor(req), dto.auditQuery.parse(req.query))),
);

export default router;
