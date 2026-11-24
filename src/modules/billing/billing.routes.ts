import express, { Router } from 'express';
import { protect } from '../admin/auth/auth.middleware.js';
import { actor, idempotencyKey } from '../../shared/http/context.js';
import { idParam, noStore, ok, pageQuery } from '../../shared/http/handler.js';
import { objectId } from '../../shared/domain/healthcare.js';
import * as invoices from './invoice.service.js';
import * as ledger from './ledger.service.js';
import * as dto from './billing.validation.js';
import * as merchants from '../payments/merchant.service.js';
import * as payments from '../payments/payment.service.js';
import { processInbox } from '../payments/payment.service.js';
import { logger } from '../../config/logger.js';

const router = Router();
const org = '/organizations/:organizationId';
const orgId = (req: express.Request) => idParam(req, 'organizationId');

// Merchant accounts
router.post(
  `${org}/merchant-accounts`,
  protect,
  ok(
    (req) =>
      merchants.registerMerchant(
        actor(req),
        orgId(req),
        dto.merchantInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.get(
  `${org}/merchant-accounts`,
  protect,
  ok((req) => merchants.listMerchants(actor(req), orgId(req), pageQuery(req))),
);
router.get(
  '/platform/merchant-accounts',
  protect,
  ok((req) => merchants.listMerchantReviews(actor(req), pageQuery(req))),
);
router.post(
  '/platform/merchant-accounts/:merchantId/decide',
  protect,
  ok((req) =>
    merchants.decideMerchant(
      actor(req),
      idParam(req, 'merchantId'),
      dto.merchantDecisionInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);

// Invoices, charges and credit notes
router.post(
  `${org}/invoices`,
  protect,
  ok(
    (req) =>
      invoices.createInvoice(
        actor(req),
        orgId(req),
        dto.invoiceInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.get(
  `${org}/invoices`,
  protect,
  noStore((req) =>
    invoices.listInvoices(actor(req), orgId(req), dto.invoiceQuery.parse(req.query)),
  ),
);
router.get(
  `${org}/invoices/:invoiceId`,
  protect,
  noStore((req) => invoices.getInvoice(actor(req), orgId(req), idParam(req, 'invoiceId'))),
);
router.post(
  `${org}/invoices/:invoiceId/issue`,
  protect,
  ok((req) =>
    invoices.issueInvoice(
      actor(req),
      orgId(req),
      idParam(req, 'invoiceId'),
      dto.expectedVersionInput.parse(req.body).expectedVersion,
      idempotencyKey(req),
    ),
  ),
);
router.post(
  `${org}/invoices/:invoiceId/discard`,
  protect,
  ok((req) =>
    invoices.voidInvoice(
      actor(req),
      orgId(req),
      idParam(req, 'invoiceId'),
      dto.voidInvoiceInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);
router.post(
  `${org}/invoices/:invoiceId/credit-notes`,
  protect,
  ok(
    (req) =>
      invoices.issueCreditNote(
        actor(req),
        orgId(req),
        idParam(req, 'invoiceId'),
        dto.creditNoteInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.get(
  `${org}/charges`,
  protect,
  noStore((req) => invoices.listCharges(actor(req), orgId(req), dto.chargeQuery.parse(req.query))),
);

// Payments, allocations and refunds
router.post(
  `${org}/payments/offline`,
  protect,
  ok(
    (req) =>
      invoices.recordOfflinePayment(
        actor(req),
        orgId(req),
        dto.offlinePaymentInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.get(
  `${org}/payments`,
  protect,
  noStore((req) =>
    invoices.listPayments(actor(req), orgId(req), dto.paymentQuery.parse(req.query)),
  ),
);
router.get(
  `${org}/payments/:paymentId`,
  protect,
  noStore((req) => invoices.getPayment(actor(req), orgId(req), idParam(req, 'paymentId'))),
);
router.post(
  `${org}/payments/:paymentId/allocations`,
  protect,
  ok(
    (req) =>
      invoices.allocatePayment(
        actor(req),
        orgId(req),
        idParam(req, 'paymentId'),
        dto.allocationInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.post(
  `${org}/payments/:paymentId/refunds`,
  protect,
  ok(
    (req) =>
      invoices.requestRefund(
        actor(req),
        orgId(req),
        idParam(req, 'paymentId'),
        dto.refundInput.parse(req.body),
        idempotencyKey(req),
      ),
    202,
  ),
);
router.get(
  `${org}/payment-disputes`,
  protect,
  noStore((req) => payments.listDisputes(actor(req), orgId(req), pageQuery(req))),
);

// Ledger and reconciliation
router.get(
  `${org}/ledger/journals`,
  protect,
  noStore((req) => ledger.listJournals(actor(req), orgId(req), dto.journalQuery.parse(req.query))),
);
router.get(
  `${org}/ledger/trial-balance`,
  protect,
  noStore((req) => ledger.trialBalance(actor(req), orgId(req))),
);
router.post(
  `${org}/reconciliations`,
  protect,
  ok(
    (req) =>
      payments.runReconciliation(
        actor(req),
        orgId(req),
        dto.reconciliationInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.get(
  `${org}/reconciliations/:runId`,
  protect,
  noStore((req) =>
    payments.getReconciliation(actor(req), orgId(req), idParam(req, 'runId'), pageQuery(req)),
  ),
);
router.post(
  `${org}/reconciliation-items/:itemId/resolve`,
  protect,
  ok((req) =>
    payments.resolveReconciliationItem(
      actor(req),
      orgId(req),
      idParam(req, 'itemId'),
      dto.resolveItemInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);

// Patient portal
router.post(
  '/appointments/:appointmentId/payment-intents',
  protect,
  ok(
    (req) =>
      payments.createAppointmentPaymentIntent(
        actor(req),
        idParam(req, 'appointmentId'),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.get(
  '/payment-intents/:intentId',
  protect,
  noStore((req) => payments.getPaymentIntent(actor(req), idParam(req, 'intentId'))),
);
router.post(
  '/payment-intents/:intentId/verify',
  protect,
  ok((req) =>
    payments.verifyCheckout(
      actor(req),
      idParam(req, 'intentId'),
      dto.checkoutVerificationInput.parse(req.body),
    ),
  ),
);
router.get(
  '/patients/:patientId/invoices',
  protect,
  noStore((req) =>
    invoices.listPatientInvoices(
      actor(req),
      idParam(req, 'patientId'),
      dto.paymentQuery.parse(req.query),
    ),
  ),
);
router.get(
  '/patients/:patientId/invoices/:invoiceId',
  protect,
  noStore((req) =>
    invoices.getPatientInvoice(actor(req), idParam(req, 'patientId'), idParam(req, 'invoiceId')),
  ),
);
router.post(
  '/patients/:patientId/invoices/:invoiceId/payment-intents',
  protect,
  ok(
    (req) =>
      payments.createInvoicePaymentIntent(
        actor(req),
        idParam(req, 'patientId'),
        idParam(req, 'invoiceId'),
        idempotencyKey(req),
      ),
    201,
  ),
);

export default router;

/**
 * Gateway webhooks are authenticated by the signature over the exact raw bytes, not by browser
 * credentials. Mount this before the JSON body parser.
 */
export const webhookRouter = Router();
let inline: Promise<unknown> = Promise.resolve();
/** Resolves once the best-effort processing started by received webhooks has settled. */
export const inlineWebhookProcessing = () => inline.then(() => undefined);
webhookRouter.post(
  '/payments/razorpay/:merchantAccountId',
  express.raw({ type: 'application/json', limit: '256kb' }),
  async (req, res) => {
    const merchantAccountId = objectId.safeParse(req.params.merchantAccountId);
    const signature = req.get('X-Razorpay-Signature') ?? '';
    const eventId = (req.get('X-Razorpay-Event-Id') ?? '').slice(0, 200);
    if (!merchantAccountId.success || !Buffer.isBuffer(req.body)) {
      res.status(400).json({ success: false, code: 'INVALID_WEBHOOK' });
      return;
    }
    const result = await payments.receiveWebhook(
      merchantAccountId.data,
      req.body,
      signature,
      eventId,
    );
    if (!result.accepted) {
      res.status(401).json({ success: false, code: 'SIGNATURE_INVALID' });
      return;
    }
    res.status(200).json({ success: true });
    // Durable receipt is acknowledged first; processing failures are retried by the worker.
    inline = inline
      .then(() => processInbox(5))
      .catch((error: unknown) => logger.warn({ err: error }, 'Inline webhook processing deferred'));
  },
);
