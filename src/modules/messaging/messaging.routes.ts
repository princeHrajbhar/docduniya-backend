import { Router, type Request } from 'express';
import { z } from 'zod';
import { protect } from '../admin/auth/auth.middleware.js';
import { actor, idempotencyKey } from '../../shared/http/context.js';
import { idParam, noStore, ok } from '../../shared/http/handler.js';
import * as messaging from './messaging.service.js';

const router = Router();
const org = '/organizations/:organizationId';
const orgId = (req: Request) => idParam(req, 'organizationId');
const conversationId = (req: Request) => idParam(req, 'conversationId');

// Patient side
router.post(
  '/patients/:patientId/conversations',
  protect,
  ok(
    (req) =>
      messaging.patientStartConversation(
        actor(req),
        idParam(req, 'patientId'),
        messaging.conversationInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.get(
  '/patients/:patientId/conversations',
  protect,
  noStore((req) => messaging.patientConversations(actor(req), idParam(req, 'patientId'))),
);
router.get(
  '/conversations/:conversationId/messages',
  protect,
  noStore((req) => messaging.patientMessages(actor(req), conversationId(req))),
);
router.post(
  '/conversations/:conversationId/messages',
  protect,
  ok(
    (req) =>
      messaging.patientPost(
        actor(req),
        conversationId(req),
        messaging.messageInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);

// Provider side
router.get(
  `${org}/conversations`,
  protect,
  noStore((req) =>
    messaging.providerInbox(actor(req), orgId(req), messaging.conversationQuery.parse(req.query)),
  ),
);
router.post(
  `${org}/conversations`,
  protect,
  ok(
    (req) =>
      messaging.providerStartConversation(
        actor(req),
        orgId(req),
        messaging.providerConversationInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.get(
  `${org}/conversations/:conversationId/messages`,
  protect,
  noStore((req) => messaging.providerMessages(actor(req), orgId(req), conversationId(req))),
);
router.post(
  `${org}/conversations/:conversationId/messages`,
  protect,
  ok(
    (req) =>
      messaging.providerPost(
        actor(req),
        orgId(req),
        conversationId(req),
        messaging.messageInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.post(
  `${org}/conversations/:conversationId/close`,
  protect,
  ok((req) =>
    messaging.closeConversation(
      actor(req),
      orgId(req),
      conversationId(req),
      z.strictObject({ expectedVersion: z.number().int().min(0) }).parse(req.body).expectedVersion,
      idempotencyKey(req),
    ),
  ),
);

export default router;
