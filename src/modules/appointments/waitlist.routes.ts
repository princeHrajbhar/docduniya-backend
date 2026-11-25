import { Router } from 'express';
import { protect } from '../admin/auth/auth.middleware.js';
import { actor, idempotencyKey } from '../../shared/http/context.js';
import { idParam, noStore, ok } from '../../shared/http/handler.js';
import * as waitlist from './waitlist.service.js';

const router = Router();

router.post(
  '/waitlist',
  protect,
  ok(
    (req) =>
      waitlist.joinWaitlist(
        actor(req),
        waitlist.waitlistInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.get(
  '/patients/:patientId/waitlist',
  protect,
  noStore((req) => waitlist.patientWaitlist(actor(req), idParam(req, 'patientId'))),
);
router.post(
  '/waitlist/:entryId/accept',
  protect,
  ok((req) => waitlist.acceptOffer(actor(req), idParam(req, 'entryId'), idempotencyKey(req))),
);
router.post(
  '/waitlist/:entryId/cancel',
  protect,
  ok((req) =>
    waitlist.leaveWaitlist(
      actor(req),
      idParam(req, 'entryId'),
      waitlist.waitlistCancel.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);
router.get(
  '/organizations/:organizationId/offerings/:offeringId/waitlist',
  protect,
  noStore((req) =>
    waitlist.providerWaitlist(
      actor(req),
      idParam(req, 'organizationId'),
      idParam(req, 'offeringId'),
    ),
  ),
);

export default router;
