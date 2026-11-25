import { createHash, randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { CommandActor, Pagination } from '../../shared/domain/healthcare.js';
import { command, conflict, transaction } from '../../shared/application/command.js';
import {
  actorRef,
  before,
  pageOf,
  scoped,
  serviceActor,
  type OperationActor,
} from '../../shared/application/scope.js';
import { stamp } from '../../shared/persistence/schema.js';
import { ApiError } from '../../utils/api-error.js';
import { isDuplicateKeyError } from '../../utils/mongo.js';
import { logger } from '../../config/logger.js';
import { authorizeOrganization } from '../access/access.service.js';
import { authorizePatient } from '../patients/patient.service.js';
import { recordChange } from '../operations/operation.service.js';
import { Appointment } from '../appointments/appointment.model.js';
import { confirmHeldAppointment } from '../appointments/appointment.service.js';
import {
  InboxEvent,
  Invoice,
  MerchantAccount,
  Payment,
  PaymentDispute,
  PaymentIntent,
  ReconciliationItem,
  ReconciliationRun,
  Refund,
} from '../billing/billing.model.js';
import {
  allocate,
  completeRefund,
  createDraftInvoice,
  issueDraft,
  outstanding,
  postReceipt,
  reserveRefund,
} from '../billing/invoice.service.js';
import type {
  checkoutVerificationInput,
  reconciliationInput,
  resolveItemInput,
} from '../billing/billing.validation.js';
import {
  GatewayRejectedError,
  GatewayUnavailableError,
  paymentGateway,
  resolveSecret,
  verifyCheckoutSignature,
  verifyWebhookSignature,
  type GatewayPayment,
} from './gateway.js';
import { activeMerchant, credentialsFor, type MerchantDocument } from './merchant.service.js';

type IntentDocument = ReturnType<typeof PaymentIntent.hydrate>;
const worker = (name: string) => serviceActor(name, randomUUID());

function presentIntent(intent: IntentDocument, merchant?: MerchantDocument) {
  return {
    id: String(intent._id),
    status: intent.status,
    outcome: intent.outcome,
    amountMinor: intent.amountMinor,
    currency: intent.currency,
    appointmentId: intent.appointmentId ? String(intent.appointmentId) : undefined,
    invoiceIds: intent.invoiceIds.map(String),
    expiresAt: intent.expiresAt,
    // Values Razorpay Checkout needs; the key id is public by design.
    checkout:
      intent.providerOrderId && merchant
        ? {
            provider: 'RAZORPAY',
            keyId: merchant.providerAccountId,
            orderId: intent.providerOrderId,
          }
        : undefined,
    version: intent.version,
  };
}

/** Creates the provider order after commit. A timeout is an unknown outcome, not a failure. */
export async function prepareOrder(intentId: string): Promise<void> {
  const now = new Date();
  const token = randomUUID();
  const intent = await PaymentIntent.findOneAndUpdate(
    {
      _id: intentId,
      providerOrderId: { $exists: false },
      status: { $in: ['CREATED', 'ORDER_PENDING'] },
      $or: [{ orderLeaseUntil: { $exists: false } }, { orderLeaseUntil: { $lte: now } }],
    },
    {
      $set: {
        status: 'ORDER_PENDING',
        orderLeaseToken: token,
        orderLeaseUntil: new Date(now.getTime() + 60_000),
        nextAttemptAt: new Date(now.getTime() + 60_000),
      },
      $inc: { orderAttempts: 1 },
    },
    { returnDocument: 'after' },
  );
  if (!intent) return;
  const merchant = await MerchantAccount.findById(intent.merchantAccountId);
  if (!merchant || merchant.status !== 'ACTIVE') {
    await PaymentIntent.updateOne(
      { _id: intent._id, orderLeaseToken: token },
      {
        $set: { status: 'RECONCILE', lastErrorCode: 'MERCHANT_INACTIVE' },
        $unset: { orderLeaseToken: 1, orderLeaseUntil: 1 },
      },
    );
    return;
  }
  const receipt = String(intent._id);
  let orderId: string | undefined;
  let errorCode: string | undefined;
  try {
    const credentials = credentialsFor(merchant);
    // A previous attempt may have succeeded remotely before the local write was lost.
    let order = await paymentGateway().findOrderByReceipt(credentials, receipt);
    if (!order && intent.expiresAt && intent.expiresAt <= now) {
      await PaymentIntent.updateOne(
        { _id: intent._id, orderLeaseToken: token },
        { $set: { status: 'CANCELLED' }, $unset: { orderLeaseToken: 1, orderLeaseUntil: 1 } },
      );
      return;
    }
    order ??= await paymentGateway().createOrder(credentials, {
      amountMinor: intent.amountMinor,
      currency: intent.currency,
      receipt,
      notes: { intentId: receipt, organizationId: String(intent.organizationId) },
    });
    if (
      order.amountMinor !== intent.amountMinor ||
      order.currency !== intent.currency ||
      (order.receipt && order.receipt !== receipt)
    ) {
      await PaymentIntent.updateOne(
        { _id: intent._id, orderLeaseToken: token },
        {
          $set: { status: 'RECONCILE', lastErrorCode: 'ORDER_MISMATCH' },
          $unset: { orderLeaseToken: 1, orderLeaseUntil: 1 },
        },
      );
      return;
    }
    orderId = order.id;
  } catch (error) {
    if (!(
      error instanceof GatewayUnavailableError ||
      error instanceof GatewayRejectedError ||
      error instanceof ApiError
    ))
      throw error;
    errorCode = error instanceof GatewayRejectedError ? error.code : 'GATEWAY_UNAVAILABLE';
  }
  await PaymentIntent.updateOne(
    { _id: intent._id, orderLeaseToken: token, providerOrderId: { $exists: false } },
    orderId
      ? {
          $set: { providerOrderId: orderId, status: 'READY' },
          $unset: { lastErrorCode: 1, nextAttemptAt: 1, orderLeaseToken: 1, orderLeaseUntil: 1 },
        }
      : {
          $set: {
            status: intent.orderAttempts >= 10 ? 'RECONCILE' : 'ORDER_PENDING',
            lastErrorCode: errorCode,
            nextAttemptAt: new Date(Date.now() + Math.min(2 ** intent.orderAttempts, 60) * 30_000),
          },
          $unset: { orderLeaseToken: 1, orderLeaseUntil: 1 },
        },
  );
}

/** Patient starts payment for a prepaid hold. One intent per hold token; the amount is server-derived. */
export async function createAppointmentPaymentIntent(
  actor: CommandActor,
  appointmentId: string,
  key: string,
) {
  const preview = await Appointment.findById(appointmentId);
  if (!preview) throw ApiError.notFound();
  await authorizePatient(actor, String(preview.patientId), 'registration.create');
  const result = await command(
    actor,
    'self',
    `payment-intent:${appointmentId}`,
    key,
    { appointmentId },
    async (session) => {
      const appointment = await Appointment.findById(appointmentId).session(session);
      if (!appointment) throw ApiError.notFound();
      await authorizePatient(
        actor,
        String(appointment.patientId),
        'registration.create',
        session,
        true,
      );
      if (appointment.paymentPolicy !== 'PREPAY')
        throw ApiError.badRequest('This appointment is not prepaid');
      if (appointment.status !== 'HELD' || appointment.holdExpiresAt <= new Date())
        throw new ApiError(
          409,
          'The hold is no longer valid; book again',
          undefined,
          'HOLD_EXPIRED',
        );
      const merchant = await activeMerchant(appointment.organizationId, session);
      const operationKey = `appointment:${appointment._id}:${appointment.holdToken}`;
      const existing = await PaymentIntent.findOne({
        organizationId: appointment.organizationId,
        operationKey,
      }).session(session);
      if (existing) return { id: String(existing._id), version: existing.version };
      const [intent] = await PaymentIntent.create(
        [
          {
            ...stamp(actor.userId),
            organizationId: appointment.organizationId,
            merchantAccountId: merchant._id,
            payerUserId: actor.userId,
            patientId: appointment.patientId,
            appointmentId: appointment._id,
            holdToken: appointment.holdToken,
            amountMinor: appointment.priceSnapshot.totalMinor,
            currency: appointment.priceSnapshot.currency,
            operationKey,
            expiresAt: appointment.holdExpiresAt,
          },
        ],
        { session },
      );
      await recordChange(
        actor,
        {
          organizationId: String(appointment.organizationId),
          patientId: String(appointment.patientId),
          action: 'PaymentIntentCreated',
          resourceType: 'paymentIntent',
          resourceId: String(intent!._id),
          version: 0,
        },
        session,
      );
      return { id: String(intent!._id), version: 0 };
    },
  );
  await prepareOrder(result.id);
  return getPaymentIntent(actor, result.id);
}

/** Patient pays an issued invoice online. */
export async function createInvoicePaymentIntent(
  actor: CommandActor,
  patientId: string,
  invoiceId: string,
  key: string,
) {
  await authorizePatient(actor, patientId, 'profile.update');
  const result = await command(
    actor,
    'self',
    `invoice-intent:${invoiceId}`,
    key,
    { patientId, invoiceId },
    async (session) => {
      await authorizePatient(actor, patientId, 'profile.update', session, true);
      const invoice = await Invoice.findOne({
        _id: invoiceId,
        patientId,
        status: 'ISSUED',
      }).session(session);
      if (!invoice) throw ApiError.notFound();
      const amountMinor = outstanding(invoice);
      if (amountMinor <= 0) conflict('The invoice has no balance due');
      const merchant = await activeMerchant(invoice.organizationId, session);
      const operationKey = `invoice:${invoiceId}:${invoice.version}:${amountMinor}`;
      const existing = await PaymentIntent.findOne({
        organizationId: invoice.organizationId,
        operationKey,
      }).session(session);
      if (existing) return { id: String(existing._id), version: existing.version };
      const [intent] = await PaymentIntent.create(
        [
          {
            ...stamp(actor.userId),
            organizationId: invoice.organizationId,
            merchantAccountId: merchant._id,
            payerUserId: actor.userId,
            patientId,
            invoiceIds: [invoice._id],
            amountMinor,
            operationKey,
            expiresAt: new Date(Date.now() + 24 * 3600_000),
          },
        ],
        { session },
      );
      await recordChange(
        actor,
        {
          organizationId: String(invoice.organizationId),
          patientId,
          action: 'PaymentIntentCreated',
          resourceType: 'paymentIntent',
          resourceId: String(intent!._id),
          version: 0,
        },
        session,
      );
      return { id: String(intent!._id), version: 0 };
    },
  );
  await prepareOrder(result.id);
  return getPaymentIntent(actor, result.id);
}

export async function getPaymentIntent(actor: CommandActor, intentId: string) {
  const intent = await PaymentIntent.findById(intentId);
  if (!intent || !intent.patientId) throw ApiError.notFound();
  await authorizePatient(actor, String(intent.patientId), 'profile.read');
  const merchant = await MerchantAccount.findById(intent.merchantAccountId);
  return presentIntent(intent, merchant ?? undefined);
}

/**
 * Applies an authoritative gateway payment. Idempotent per provider payment id. A capture whose
 * hold is no longer valid is recorded faithfully and becomes a refund obligation; it never
 * resurrects a booking or evicts a newer claimant.
 */
async function applyCapture(
  actor: OperationActor,
  merchant: MerchantDocument,
  remote: GatewayPayment,
) {
  if (remote.status !== 'captured') return 'IGNORED' as const;
  return transaction(async (session) => {
    const existing = await Payment.findOne({
      merchantAccountId: merchant._id,
      providerPaymentId: remote.id,
    }).session(session);
    if (existing?.status === 'CAPTURED') return 'DUPLICATE' as const;
    const intent = remote.orderId
      ? await PaymentIntent.findOne({
          merchantAccountId: merchant._id,
          providerOrderId: remote.orderId,
        }).session(session)
      : null;
    if (!intent) {
      logger.warn(
        { merchantAccountId: String(merchant._id) },
        'Capture without a matching payment intent',
      );
      return 'UNMATCHED' as const;
    }
    const who = actorRef(actor);
    const payment =
      existing ??
      new Payment({
        organizationId: intent.organizationId,
        intentId: intent._id,
        merchantAccountId: merchant._id,
        providerPaymentId: remote.id,
        method: 'GATEWAY',
        patientId: intent.patientId,
        createdBy: who,
      });
    payment.set({
      status: 'CAPTURED',
      amountMinor: remote.amountMinor,
      currency: 'INR',
      capturedAt: new Date(),
      updatedBy: who,
    });
    await payment.save({ session });
    await postReceipt(actor, payment, session);
    await recordChange(
      actor,
      {
        organizationId: String(intent.organizationId),
        patientId: intent.patientId ? String(intent.patientId) : undefined,
        action: 'PaymentCaptured',
        resourceType: 'payment',
        resourceId: String(payment._id),
        version: payment.version,
      },
      session,
    );
    const matches =
      remote.currency === intent.currency && remote.amountMinor === intent.amountMinor;
    let outcome: 'CONFIRMED' | 'INVOICE_PAID' | 'REFUND_REQUIRED' = 'REFUND_REQUIRED';
    if (matches && intent.appointmentId) {
      const appointment = await Appointment.findById(intent.appointmentId).session(session);
      if (
        appointment &&
        (await confirmHeldAppointment(actor, appointment, session, intent.holdToken!))
      ) {
        const invoice = await createDraftInvoice(
          actor,
          {
            organizationId: String(appointment.organizationId),
            patientRegistrationId: String(appointment.registrationId),
            facilityId: String(appointment.facilityId),
            appointmentId: String(appointment._id),
            dueInDays: 0,
            lines: [
              {
                description: appointment.offeringSnapshot.name,
                quantity: 1,
                unitPriceMinor: appointment.priceSnapshot.amountMinor,
                discountMinor: 0,
                taxBasisPoints: appointment.priceSnapshot.taxBasisPoints ?? 0,
              },
            ],
          },
          session,
        );
        await issueDraft(actor, invoice, session);
        if (invoice.totalMinor !== payment.amountMinor)
          throw new Error('Invoice total differs from the accepted quote');
        await allocate(
          actor,
          payment,
          invoice,
          payment.amountMinor,
          `capture:${payment._id}`,
          session,
        );
        outcome = 'CONFIRMED';
      } else if (appointment && !appointment.refundRequired) {
        appointment.refundRequired = true;
        appointment.updatedBy = who;
        await appointment.save({ session });
      }
    } else if (matches && intent.invoiceIds.length === 1) {
      const invoice = await Invoice.findById(intent.invoiceIds[0]).session(session);
      if (invoice && outstanding(invoice) >= payment.amountMinor) {
        await allocate(
          actor,
          payment,
          invoice,
          payment.amountMinor,
          `capture:${payment._id}`,
          session,
        );
        outcome = 'INVOICE_PAID';
      }
    }
    if (outcome === 'REFUND_REQUIRED')
      await reserveRefund(
        actor,
        payment,
        payment.amountMinor,
        'Capture could not be applied to a valid booking or balance',
        `late-capture:${payment._id}`,
        session,
      );
    intent.status = matches ? 'SUCCEEDED' : 'RECONCILE';
    intent.outcome = outcome;
    intent.updatedBy = who;
    await intent.save({ session });
    return outcome;
  });
}

/** Fetches the authoritative payment, captures an authorized one, then applies it. */
async function settleRemotePayment(merchant: MerchantDocument, paymentId: string) {
  const credentials = credentialsFor(merchant);
  let remote = await paymentGateway().fetchPayment(credentials, paymentId);
  if (remote.status === 'authorized')
    remote = await paymentGateway().capturePayment(credentials, remote);
  return applyCapture(worker('payment-capture'), merchant, remote);
}

/** Checkout success callback. The signature proves origin; the amount comes from a server fetch. */
export async function verifyCheckout(
  actor: CommandActor,
  intentId: string,
  input: z.infer<typeof checkoutVerificationInput>,
) {
  const intent = await PaymentIntent.findById(intentId);
  if (!intent || !intent.patientId) throw ApiError.notFound();
  await authorizePatient(actor, String(intent.patientId), 'profile.read');
  const merchant = await MerchantAccount.findById(intent.merchantAccountId);
  if (!merchant || intent.providerOrderId !== input.orderId)
    throw ApiError.badRequest('Payment does not match this intent');
  if (
    !verifyCheckoutSignature(
      resolveSecret(merchant.keySecretRef),
      input.orderId,
      input.paymentId,
      input.signature,
    )
  )
    throw new ApiError(400, 'Payment signature is invalid', undefined, 'SIGNATURE_INVALID');
  try {
    await settleRemotePayment(merchant, input.paymentId);
  } catch (error) {
    if (!(error instanceof GatewayUnavailableError)) throw error;
    // The webhook and reconciliation complete this later; report the durable state.
  }
  return getPaymentIntent(actor, intentId);
}

// ── Webhook inbox ────────────────────────────────────────────────────────────

type RazorpayEvent = {
  event?: string;
  payload?: {
    payment?: {
      entity?: {
        id?: string;
        order_id?: string;
        amount?: number;
        currency?: string;
        status?: string;
      };
    };
    refund?: { entity?: { id?: string; payment_id?: string; amount?: number; status?: string } };
    dispute?: {
      entity?: {
        id?: string;
        payment_id?: string;
        amount?: number;
        reason_code?: string;
        respond_by?: number;
        status?: string;
      };
    };
  };
};

/**
 * Verifies the raw bytes, durably inserts a deduplicated inbox row, then acknowledges. Returns
 * false when the signature is invalid. Persistence failures propagate so the gateway retries.
 */
export async function receiveWebhook(
  merchantAccountId: string,
  rawBody: Buffer,
  signature: string,
  eventId: string,
) {
  const merchant = await MerchantAccount.findOne({
    _id: merchantAccountId,
    status: { $in: ['ACTIVE', 'RESTRICTED'] },
  });
  if (!merchant) return { accepted: false as const };
  if (!verifyWebhookSignature(resolveSecret(merchant.webhookSecretRef), rawBody, signature))
    return { accepted: false as const };
  let event: RazorpayEvent;
  try {
    event = JSON.parse(rawBody.toString('utf8')) as RazorpayEvent;
  } catch {
    return { accepted: false as const };
  }
  const payment = event.payload?.payment?.entity;
  const refund = event.payload?.refund?.entity;
  const dispute = event.payload?.dispute?.entity;
  const payloadHash = createHash('sha256').update(rawBody).digest('hex');
  try {
    const [row] = await InboxEvent.create([
      {
        source: 'razorpay',
        sourceAccount: String(merchant._id),
        externalEventId: eventId || payloadHash,
        eventType: String(event.event ?? 'unknown').slice(0, 100),
        payloadHash,
        verified: true,
        extract: {
          paymentId: payment?.id ?? refund?.payment_id ?? dispute?.payment_id,
          orderId: payment?.order_id,
          refundId: refund?.id,
          disputeId: dispute?.id,
          amountMinor: refund?.amount ?? dispute?.amount ?? payment?.amount,
          currency: payment?.currency,
          status: refund?.status ?? dispute?.status ?? payment?.status,
          reasonCode: dispute?.reason_code,
          dueBy: dispute?.respond_by,
        },
      },
    ]);
    return { accepted: true as const, inboxId: String(row!._id) };
  } catch (error) {
    if (isDuplicateKeyError(error)) return { accepted: true as const, duplicate: true };
    throw error;
  }
}

async function handleInbox(
  row: ReturnType<typeof InboxEvent.hydrate>,
): Promise<'PROCESSED' | 'IGNORED'> {
  const merchant = await MerchantAccount.findById(row.sourceAccount);
  if (!merchant) return 'IGNORED';
  const { extract } = row;
  switch (row.eventType) {
    case 'payment.captured':
    case 'order.paid':
    case 'payment.authorized':
      if (!extract.paymentId) return 'IGNORED';
      return (await settleRemotePayment(merchant, extract.paymentId)) === 'IGNORED'
        ? 'IGNORED'
        : 'PROCESSED';
    case 'refund.processed':
    case 'refund.failed': {
      if (!extract.refundId) return 'IGNORED';
      await transaction(async (session) => {
        const refund = await Refund.findOne({
          organizationId: merchant.organizationId,
          providerRefundId: extract.refundId,
        }).session(session);
        if (!refund || ['SUCCEEDED', 'FAILED'].includes(refund.status)) return;
        const payment = await Payment.findById(refund.paymentId).session(session);
        if (!payment) return;
        await completeRefund(worker('refund-webhook'), refund, payment, session, {
          success: row.eventType === 'refund.processed',
          failureCode: row.eventType === 'refund.failed' ? 'GATEWAY_REFUND_FAILED' : undefined,
        });
      });
      return 'PROCESSED';
    }
    case 'payment.dispute.created':
    case 'payment.dispute.won':
    case 'payment.dispute.lost':
    case 'payment.dispute.closed': {
      if (!extract.disputeId || !extract.paymentId) return 'IGNORED';
      const payment = await Payment.findOne({
        merchantAccountId: merchant._id,
        providerPaymentId: extract.paymentId,
      });
      if (!payment) return 'IGNORED';
      const status = {
        'payment.dispute.created': 'OPEN',
        'payment.dispute.won': 'WON',
        'payment.dispute.lost': 'LOST',
        'payment.dispute.closed': 'CLOSED',
      }[row.eventType];
      const who = { kind: 'SERVICE' as const, id: 'payment-disputes' };
      await PaymentDispute.updateOne(
        { organizationId: payment.organizationId, providerDisputeId: extract.disputeId },
        {
          $set: { status, updatedBy: who },
          $setOnInsert: {
            paymentId: payment._id,
            amountMinor: extract.amountMinor ?? 0,
            reasonCode: extract.reasonCode,
            dueAt: extract.dueBy ? new Date(extract.dueBy * 1000) : undefined,
            createdBy: who,
          },
        },
        { upsert: true },
      );
      return 'PROCESSED';
    }
    default:
      return 'IGNORED';
  }
}

/** Leases and processes verified inbox rows. Safe to run concurrently and to replay. */
export async function processInbox(limit = 25): Promise<number> {
  let processed = 0;
  for (let index = 0; index < limit; index += 1) {
    const now = new Date();
    const row = await InboxEvent.findOneAndUpdate(
      {
        verified: true,
        $or: [
          { state: 'RECEIVED', nextAttemptAt: { $lte: now } },
          { state: 'FAILED', nextAttemptAt: { $lte: now }, attempts: { $lt: 10 } },
          { state: 'PROCESSING', leaseUntil: { $lt: now } },
        ],
      },
      {
        $set: { state: 'PROCESSING', leaseUntil: new Date(now.getTime() + 60_000) },
        $inc: { attempts: 1 },
      },
      { returnDocument: 'after', sort: { receivedAt: 1 } },
    );
    if (!row) break;
    try {
      const state = await handleInbox(row);
      await InboxEvent.updateOne(
        { _id: row._id },
        { $set: { state }, $unset: { leaseUntil: 1, errorCode: 1 } },
      );
      processed += 1;
    } catch (error) {
      await InboxEvent.updateOne(
        { _id: row._id },
        {
          $set: {
            state: 'FAILED',
            errorCode: error instanceof Error ? error.name : 'Error',
            nextAttemptAt: new Date(Date.now() + Math.min(2 ** row.attempts, 64) * 15_000),
          },
          $unset: { leaseUntil: 1 },
        },
      );
    }
  }
  return processed;
}

/** Sends reserved refunds to the gateway with a stable idempotency key. */
export async function processRefunds(limit = 25): Promise<number> {
  const due = await Refund.find({
    status: { $in: ['REQUESTED', 'PROCESSING'] },
    nextAttemptAt: { $lte: new Date() },
    attempts: { $lt: 20 },
  })
    .sort({ nextAttemptAt: 1 })
    .limit(limit);
  let handled = 0;
  for (const candidate of due) {
    const leased = await Refund.findOneAndUpdate(
      {
        _id: candidate._id,
        version: candidate.version,
        status: { $in: ['REQUESTED', 'PROCESSING'] },
      },
      {
        $set: { status: 'PROCESSING', nextAttemptAt: new Date(Date.now() + 5 * 60_000) },
        $inc: { attempts: 1, version: 1 },
      },
      { returnDocument: 'after' },
    );
    if (!leased) continue;
    const payment = await Payment.findById(leased.paymentId);
    const merchant = payment?.merchantAccountId
      ? await MerchantAccount.findById(payment.merchantAccountId)
      : null;
    if (!payment || !merchant || !payment.providerPaymentId) continue;
    let outcome: { success: boolean; providerRefundId?: string; failureCode?: string } | undefined;
    try {
      const remote = await paymentGateway().createRefund(credentialsFor(merchant), {
        paymentId: payment.providerPaymentId,
        amountMinor: leased.amountMinor,
        idempotencyKey: String(leased._id),
      });
      if (remote.status === 'processed') outcome = { success: true, providerRefundId: remote.id };
      else if (remote.status === 'failed')
        outcome = {
          success: false,
          providerRefundId: remote.id,
          failureCode: 'GATEWAY_REFUND_FAILED',
        };
      else await Refund.updateOne({ _id: leased._id }, { $set: { providerRefundId: remote.id } });
    } catch (error) {
      if (error instanceof GatewayRejectedError)
        outcome = { success: false, failureCode: error.code.slice(0, 100) };
      else if (!(error instanceof GatewayUnavailableError)) throw error;
      // Unknown outcome: retry later with the same idempotency key.
    }
    if (outcome) {
      const final = outcome;
      await transaction(async (session) => {
        const refund = await Refund.findById(leased._id).session(session);
        const current = await Payment.findById(payment._id).session(session);
        if (refund && current)
          await completeRefund(worker('refund-worker'), refund, current, session, final);
      });
    }
    handled += 1;
  }
  return handled;
}

/** Retries provider-order creation for intents whose earlier attempt had an unknown outcome. */
export async function retryPendingOrders(limit = 25): Promise<number> {
  const rows = await PaymentIntent.find({
    status: { $in: ['CREATED', 'ORDER_PENDING'] },
    $and: [
      { $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: new Date() } }] },
      { $or: [{ orderLeaseUntil: { $exists: false } }, { orderLeaseUntil: { $lte: new Date() } }] },
    ],
    orderAttempts: { $lt: 10 },
  })
    .select({ _id: 1 })
    .limit(limit)
    .lean();
  for (const row of rows) await prepareOrder(String(row._id));
  return rows.length;
}

// ── Reconciliation ───────────────────────────────────────────────────────────

export async function runReconciliation(
  actor: CommandActor,
  organizationId: string,
  input: z.infer<typeof reconciliationInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'billing.manage', { organizationWide: true });
  const merchant = await MerchantAccount.findOne({ _id: input.merchantAccountId, organizationId });
  if (!merchant) throw ApiError.notFound();
  const created = await command(
    actor,
    organizationId,
    'reconciliation.run',
    key,
    input,
    async (session) => {
      await scoped(actor, organizationId, 'billing.manage', session, { organizationWide: true });
      const [run] = await ReconciliationRun.create(
        [
          {
            ...stamp(actor.userId),
            organizationId,
            merchantAccountId: merchant._id,
            periodStart: new Date(input.from),
            periodEnd: new Date(input.to),
          },
        ],
        { session },
      );
      return { id: String(run!._id), version: 0 };
    },
  );
  const run = await ReconciliationRun.findById(created.id);
  if (!run || run.status !== 'RUNNING') return created;
  try {
    const remote = await paymentGateway().listPayments(
      credentialsFor(merchant),
      run.periodStart,
      run.periodEnd,
    );
    const local = await Payment.find({
      merchantAccountId: merchant._id,
      capturedAt: { $gte: run.periodStart, $lt: run.periodEnd },
    }).lean();
    const byId = new Map(local.map((row) => [row.providerPaymentId!, row]));
    let matched = 0;
    let exceptions = 0;
    const who = { kind: 'USER' as const, id: actor.userId };
    for (const row of remote.filter(
      (payment) => payment.status === 'captured' || payment.status === 'refunded',
    )) {
      const mine = byId.get(row.id);
      byId.delete(row.id);
      const status = !mine
        ? 'MISSING_LOCAL'
        : mine.amountMinor !== row.amountMinor
          ? 'MISMATCH'
          : 'MATCHED';
      if (status === 'MATCHED') matched += 1;
      else exceptions += 1;
      await ReconciliationItem.updateOne(
        { organizationId, runId: run._id, providerRowKey: row.id },
        {
          $setOnInsert: {
            providerReference: row.id,
            localPaymentId: mine?._id,
            expectedMinor: mine?.amountMinor ?? 0,
            actualMinor: row.amountMinor,
            status,
            createdBy: who,
            updatedBy: who,
          },
        },
        { upsert: true },
      );
    }
    for (const [providerId, mine] of byId) {
      exceptions += 1;
      await ReconciliationItem.updateOne(
        { organizationId, runId: run._id, providerRowKey: providerId },
        {
          $setOnInsert: {
            providerReference: providerId,
            localPaymentId: mine._id,
            expectedMinor: mine.amountMinor,
            actualMinor: 0,
            status: 'MISSING_PROVIDER',
            createdBy: who,
            updatedBy: who,
          },
        },
        { upsert: true },
      );
    }
    run.set({
      status: 'COMPLETE',
      matchedCount: matched,
      exceptionCount: exceptions,
      completedAt: new Date(),
      updatedBy: who,
    });
  } catch (error) {
    if (!(error instanceof GatewayUnavailableError || error instanceof GatewayRejectedError))
      throw error;
    run.set({
      status: 'FAILED',
      errorCode: error instanceof GatewayRejectedError ? error.code : 'GATEWAY_UNAVAILABLE',
    });
  }
  await run.save();
  return { id: String(run._id), version: run.version };
}

export async function getReconciliation(
  actor: CommandActor,
  organizationId: string,
  runId: string,
  page: Pagination,
) {
  await authorizeOrganization(actor, organizationId, 'billing.manage', { organizationWide: true });
  const run = await ReconciliationRun.findOne({ _id: runId, organizationId }).lean();
  if (!run) throw ApiError.notFound();
  const rows = await ReconciliationItem.find({ organizationId, runId, ...before(page.before) })
    .sort({ _id: -1 })
    .limit(page.limit + 1)
    .lean();
  return {
    id: String(run._id),
    status: run.status,
    periodStart: run.periodStart,
    periodEnd: run.periodEnd,
    matchedCount: run.matchedCount,
    exceptionCount: run.exceptionCount,
    items: pageOf(rows, page.limit, (row) => ({
      id: String(row._id),
      providerReference: row.providerReference,
      localPaymentId: row.localPaymentId ? String(row.localPaymentId) : undefined,
      expectedMinor: row.expectedMinor,
      actualMinor: row.actualMinor,
      status: row.status,
      resolution: row.resolution,
      version: row.version,
    })),
  };
}

/** Resolves an exception. A missing local capture is re-fetched and applied through the normal path. */
export async function resolveReconciliationItem(
  actor: CommandActor,
  organizationId: string,
  itemId: string,
  input: z.infer<typeof resolveItemInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'billing.manage', { organizationWide: true });
  const item = await ReconciliationItem.findOne({ _id: itemId, organizationId });
  if (!item) throw ApiError.notFound();
  if (item.status === 'MISSING_LOCAL') {
    const run = await ReconciliationRun.findById(item.runId);
    const merchant = run ? await MerchantAccount.findById(run.merchantAccountId) : null;
    if (merchant) await settleRemotePayment(merchant, item.providerReference);
  }
  return command(
    actor,
    organizationId,
    `reconciliation.resolve:${itemId}`,
    key,
    input,
    async (session) => {
      await scoped(actor, organizationId, 'billing.manage', session, { organizationWide: true });
      const current = await ReconciliationItem.findOne({
        _id: itemId,
        organizationId,
        version: input.expectedVersion,
      }).session(session);
      if (!current) conflict();
      if (current.status === 'MATCHED' || current.status === 'RESOLVED')
        conflict('Nothing to resolve');
      current.status = 'RESOLVED';
      current.resolution = input.resolution;
      current.updatedBy = { kind: 'USER', id: actor.userId };
      await current.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          action: 'ReconciliationItemResolved',
          resourceType: 'reconciliationItem',
          resourceId: itemId,
          version: current.version,
          reason: input.resolution,
        },
        session,
      );
      return { id: itemId, version: current.version };
    },
  );
}

export async function listDisputes(actor: CommandActor, organizationId: string, page: Pagination) {
  await authorizeOrganization(actor, organizationId, 'billing.read');
  const rows = await PaymentDispute.find({ organizationId, ...before(page.before) })
    .sort({ _id: -1 })
    .limit(page.limit + 1)
    .lean();
  return pageOf(rows, page.limit, (row) => ({
    id: String(row._id),
    paymentId: String(row.paymentId),
    providerDisputeId: row.providerDisputeId,
    amountMinor: row.amountMinor,
    reasonCode: row.reasonCode,
    status: row.status,
    dueAt: row.dueAt,
  }));
}
