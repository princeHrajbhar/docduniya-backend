import { Router, type Request } from 'express';
import { protect, requirePermission } from '../admin/auth/auth.middleware.js';
import { PERMISSIONS } from '../admin/auth/roles/permission.constants.js';
import { actor, idempotencyKey, param } from '../../shared/http/context.js';
import { objectId, paginationInput } from '../../shared/domain/healthcare.js';
import * as dto from './provider.validation.js';
import * as verification from './verification.service.js';
import * as affiliation from './affiliation.service.js';
import { discoverDoctors } from './discovery.service.js';

const router = Router();
const id = (req: Request, name: string) => objectId.parse(param(req, name));
const page = (req: Request) => paginationInput.parse(req.query);
const reviewer = requirePermission(PERMISSIONS.DOCTORS_VERIFY);

router.post('/doctors/me/verification-requests', protect, async (req, res) =>
  res.status(201).json({
    success: true,
    data: await verification.submitDoctorVerification(
      actor(req),
      dto.verificationSubmission.parse(req.body),
      idempotencyKey(req),
    ),
  }),
);
router.get('/doctors/me/verification-requests', protect, async (req, res) =>
  res.json({
    success: true,
    data: await verification.listDoctorVerifications(actor(req), page(req)),
  }),
);
router.get('/doctors/me/verification-requests/:reviewId', protect, async (req, res) =>
  res.json({
    success: true,
    data: await verification.getDoctorVerification(actor(req), id(req, 'reviewId')),
  }),
);
router.post('/doctors/me/withdraw-verification', protect, async (req, res) =>
  res.json({
    success: true,
    data: await verification.withdrawDoctorVerification(
      actor(req),
      dto.withdrawVerificationInput.parse(req.body),
      idempotencyKey(req),
    ),
  }),
);
router.post('/doctors/me/publication', protect, async (req, res) =>
  res.json({
    success: true,
    data: await affiliation.publishDoctor(
      actor(req),
      dto.publicationInput.parse(req.body),
      idempotencyKey(req),
    ),
  }),
);
router.get('/doctors/me/affiliations', protect, async (req, res) =>
  res.json({ success: true, data: await affiliation.listAffiliations(actor(req), page(req)) }),
);
router.post('/doctors/me/affiliations/:affiliationId/respond', protect, async (req, res) =>
  res.json({
    success: true,
    data: await affiliation.respondToAffiliation(
      actor(req),
      id(req, 'affiliationId'),
      dto.affiliationResponse.parse(req.body),
      idempotencyKey(req),
    ),
  }),
);
router.post('/doctors/me/affiliations/:affiliationId/end', protect, async (req, res) =>
  res.json({
    success: true,
    data: await affiliation.endOwnAffiliation(
      actor(req),
      id(req, 'affiliationId'),
      dto.ownAffiliationEnd.parse(req.body),
      idempotencyKey(req),
    ),
  }),
);

router.post('/organizations/:organizationId/doctor-affiliations', protect, async (req, res) =>
  res.status(201).json({
    success: true,
    data: await affiliation.inviteAffiliation(
      actor(req),
      id(req, 'organizationId'),
      dto.affiliationInput.parse(req.body),
      idempotencyKey(req),
    ),
  }),
);
router.get('/organizations/:organizationId/doctor-affiliations', protect, async (req, res) =>
  res.json({
    success: true,
    data: await affiliation.listAffiliations(actor(req), page(req), id(req, 'organizationId')),
  }),
);
router.post(
  '/organizations/:organizationId/doctor-affiliations/:affiliationId/state',
  protect,
  async (req, res) =>
    res.json({
      success: true,
      data: await affiliation.changeAffiliation(
        actor(req),
        id(req, 'organizationId'),
        id(req, 'affiliationId'),
        dto.affiliationState.parse(req.body),
        idempotencyKey(req),
      ),
    }),
);

router.get('/platform/doctor-verifications', protect, reviewer, async (req, res) =>
  res.json({
    success: true,
    data: await verification.listDoctorVerifications(actor(req), page(req), true),
  }),
);
router.get('/platform/doctor-verifications/:reviewId', protect, reviewer, async (req, res) =>
  res.json({
    success: true,
    data: await verification.getDoctorVerification(actor(req), id(req, 'reviewId'), true),
  }),
);
router.post(
  '/platform/doctor-verifications/:reviewId/decide',
  protect,
  reviewer,
  async (req, res) =>
    res.json({
      success: true,
      data: await verification.decideDoctorVerification(
        actor(req),
        id(req, 'reviewId'),
        dto.verificationDecision.parse(req.body),
        idempotencyKey(req),
      ),
    }),
);
router.post('/platform/doctors/:doctorId/restriction', protect, reviewer, async (req, res) =>
  res.json({
    success: true,
    data: await verification.restrictDoctor(
      actor(req),
      id(req, 'doctorId'),
      dto.doctorRestrictionInput.parse(req.body),
      idempotencyKey(req),
    ),
  }),
);
router.get('/discovery/doctors', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: await discoverDoctors(dto.discoveryQuery.parse(req.query)) });
});
export default router;
