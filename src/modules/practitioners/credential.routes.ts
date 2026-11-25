import { Router } from 'express';
import { protect } from '../admin/auth/auth.middleware.js';
import { actor, idempotencyKey } from '../../shared/http/context.js';
import { idParam, noStore, ok } from '../../shared/http/handler.js';
import * as credentials from './credential.service.js';

/** Non-doctor professional credential review (nurses, pharmacists, laboratory and allied). */
const router = Router();

router.post(
  '/professionals/me/credential-reviews',
  protect,
  ok(
    (req) =>
      credentials.submitCredential(
        actor(req),
        credentials.credentialSubmission.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.get(
  '/professionals/me/credential-reviews',
  protect,
  noStore((req) => credentials.myCredentialReviews(actor(req))),
);
router.get(
  '/admin/professional-credential-reviews',
  protect,
  noStore((req) =>
    credentials.listCredentialReviews(actor(req), credentials.credentialQuery.parse(req.query)),
  ),
);
router.post(
  '/admin/professional-credential-reviews/:reviewId/decision',
  protect,
  ok((req) =>
    credentials.decideCredential(
      actor(req),
      idParam(req, 'reviewId'),
      credentials.credentialDecision.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);
router.post(
  '/admin/professional-credential-reviews/:reviewId/suspension',
  protect,
  ok((req) =>
    credentials.suspendCredential(
      actor(req),
      idParam(req, 'reviewId'),
      credentials.credentialRestriction.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);

export default router;
