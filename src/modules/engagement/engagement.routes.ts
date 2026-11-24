import { Router, type Request } from 'express';
import { protect } from '../admin/auth/auth.middleware.js';
import { actor, idempotencyKey } from '../../shared/http/context.js';
import { idParam, noStore, ok, pageQuery } from '../../shared/http/handler.js';
import * as engagement from './engagement.service.js';
import * as notifications from '../notifications/notification.service.js';
import * as commerce from '../commerce/subscription.service.js';
import * as outbox from '../operations/outbox.relay.js';
import { requirePlatformPermission } from '../access/platform-access.js';
import { PERMISSIONS } from '../admin/auth/roles/permission.constants.js';

const router = Router();
const orgId = (req: Request) => idParam(req, 'organizationId');

// In-app notifications
router.get(
  '/me/notifications',
  protect,
  noStore((req) => notifications.listMyNotifications(actor(req), pageQuery(req))),
);
router.post(
  '/me/notifications/:notificationId/read',
  protect,
  ok((req) => notifications.markNotificationRead(actor(req), idParam(req, 'notificationId'))),
);

// Support
router.post(
  '/support-tickets',
  protect,
  ok(
    (req) =>
      engagement.createTicket(
        actor(req),
        engagement.ticketInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.get(
  '/me/support-tickets',
  protect,
  noStore((req) => engagement.listMyTickets(actor(req), engagement.ticketQuery.parse(req.query))),
);
router.post(
  '/support-tickets/:ticketId/replies',
  protect,
  ok(
    (req) =>
      engagement.replyToTicket(
        actor(req),
        idParam(req, 'ticketId'),
        engagement.ticketReplyInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.get(
  '/platform/support-tickets',
  protect,
  noStore((req) => engagement.listTicketQueue(actor(req), engagement.ticketQuery.parse(req.query))),
);
router.post(
  '/platform/support-tickets/:ticketId/transition',
  protect,
  ok((req) =>
    engagement.actOnTicket(
      actor(req),
      idParam(req, 'ticketId'),
      engagement.ticketActionInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);

// Reviews
router.post(
  '/reviews',
  protect,
  ok(
    (req) =>
      engagement.submitReview(
        actor(req),
        engagement.reviewInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.get(
  '/doctors/:doctorId/reviews',
  noStore((req) => engagement.publicReviews(idParam(req, 'doctorId'), pageQuery(req))),
);
router.get(
  '/platform/reviews',
  protect,
  noStore((req) => engagement.moderationQueue(actor(req), pageQuery(req))),
);
router.post(
  '/platform/reviews/:reviewId/moderate',
  protect,
  ok((req) =>
    engagement.moderateReview(
      actor(req),
      idParam(req, 'reviewId'),
      engagement.moderationInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);
router.post(
  '/organizations/:organizationId/reviews/:reviewId/reply',
  protect,
  ok((req) =>
    engagement.replyToReview(
      actor(req),
      orgId(req),
      idParam(req, 'reviewId'),
      engagement.replyInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);

// Provider subscriptions
router.get(
  '/subscription-plans',
  noStore(async () => commerce.listPlans()),
);
router.post(
  '/platform/subscription-plans',
  protect,
  ok(
    (req) =>
      commerce.publishPlan(actor(req), commerce.planInput.parse(req.body), idempotencyKey(req)),
    201,
  ),
);
router.get(
  '/platform/subscriptions',
  protect,
  noStore((req) => commerce.listSubscriptions(actor(req), pageQuery(req))),
);
router.post(
  '/platform/subscriptions/:subscriptionId/payments',
  protect,
  ok((req) =>
    commerce.recordSubscriptionPayment(
      actor(req),
      idParam(req, 'subscriptionId'),
      commerce.subscriptionPaymentInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);
router.get(
  '/organizations/:organizationId/subscription',
  protect,
  noStore((req) => commerce.currentSubscription(actor(req), orgId(req))),
);
router.post(
  '/organizations/:organizationId/subscriptions',
  protect,
  ok(
    (req) =>
      commerce.subscribe(
        actor(req),
        orgId(req),
        commerce.subscribeInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.post(
  '/organizations/:organizationId/subscriptions/:subscriptionId/transition',
  protect,
  ok((req) =>
    commerce.actOnSubscription(
      actor(req),
      orgId(req),
      idParam(req, 'subscriptionId'),
      commerce.subscriptionActionInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);

// Event delivery operations
router.get(
  '/platform/outbox/failed',
  protect,
  noStore((req) => outbox.listFailedEvents(actor(req), pageQuery(req))),
);
router.post(
  '/platform/outbox/:eventId/replay',
  protect,
  ok((req) => outbox.replayEvent(actor(req), idParam(req, 'eventId'))),
);
router.get(
  '/platform/operations/health',
  protect,
  noStore(async (req) => {
    await requirePlatformPermission(actor(req), PERMISSIONS.OPERATIONS_MANAGE);
    return outbox.outboxHealth();
  }),
);

export default router;
