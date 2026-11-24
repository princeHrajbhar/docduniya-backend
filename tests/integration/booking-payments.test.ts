import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { inlineWebhookProcessing } from '../../src/modules/billing/billing.routes.js';
import * as appointments from '../../src/modules/appointments/appointment.service.js';
import { Appointment, QueueEntry } from '../../src/modules/appointments/appointment.model.js';
import * as queue from '../../src/modules/appointments/queue.service.js';
import { ResourceClaim } from '../../src/modules/scheduling/scheduling.model.js';
import * as scheduling from '../../src/modules/scheduling/scheduling.service.js';
import * as invoices from '../../src/modules/billing/invoice.service.js';
import { trialBalance } from '../../src/modules/billing/ledger.service.js';
import {
  Invoice,
  Payment,
  PaymentIntent,
  Refund,
  InboxEvent,
  CreditNote,
} from '../../src/modules/billing/billing.model.js';
import * as merchants from '../../src/modules/payments/merchant.service.js';
import * as payments from '../../src/modules/payments/payment.service.js';
import {
  setPaymentGateway,
  sign,
  type GatewayPayment,
  type PaymentGateway,
} from '../../src/modules/payments/gateway.js';
import { PatientRegistration } from '../../src/modules/patients/patient.model.js';
import {
  account,
  bookableOffering,
  key,
  patient,
  platformAdmin,
  provider,
  slot,
  startDatabase,
  stopDatabase,
  verifiedDoctor,
  type Identity,
} from './support.js';

const app = createApp();
process.env.RAZORPAY_KEY_SECRET_TEST = 'synthetic-key-secret';
process.env.RAZORPAY_WEBHOOK_SECRET_TEST = 'synthetic-webhook-secret';

/** In-memory gateway that behaves like an auto-capturing Razorpay account. */
class FakeGateway implements PaymentGateway {
  orders = new Map<
    string,
    { id: string; amountMinor: number; currency: string; receipt: string }
  >();
  payments = new Map<string, GatewayPayment>();
  refunds: Array<{ paymentId: string; amountMinor: number; idempotencyKey: string }> = [];
  async createOrder(
    _c: unknown,
    input: { amountMinor: number; currency: string; receipt: string },
  ) {
    const order = { id: `order_${randomUUID().replaceAll('-', '').slice(0, 14)}`, ...input };
    this.orders.set(order.id, order);
    return order;
  }
  async findOrderByReceipt(_c: unknown, receipt: string) {
    return [...this.orders.values()].find((order) => order.receipt === receipt);
  }
  async fetchPayment(_c: unknown, id: string) {
    return this.payments.get(id)!;
  }
  async capturePayment(_c: unknown, payment: GatewayPayment) {
    const captured = { ...payment, status: 'captured' as const };
    this.payments.set(payment.id, captured);
    return captured;
  }
  async listPayments() {
    return [...this.payments.values()];
  }
  async createRefund(
    _c: unknown,
    input: { paymentId: string; amountMinor: number; idempotencyKey: string },
  ) {
    if (!this.refunds.some((refund) => refund.idempotencyKey === input.idempotencyKey))
      this.refunds.push(input);
    return {
      id: `rfnd_${input.idempotencyKey.slice(-12)}`,
      paymentId: input.paymentId,
      amountMinor: input.amountMinor,
      status: 'processed' as const,
    };
  }
  pay(orderId: string, amountMinor?: number) {
    const order = this.orders.get(orderId)!;
    const payment: GatewayPayment = {
      id: `pay_${randomUUID().replaceAll('-', '').slice(0, 14)}`,
      orderId,
      amountMinor: amountMinor ?? order.amountMinor,
      currency: 'INR',
      status: 'captured',
    };
    this.payments.set(payment.id, payment);
    return payment;
  }
}
const gateway = new FakeGateway();

async function webhook(
  merchantId: string,
  event: string,
  paymentId: string,
  orderId?: string,
  eventId = randomUUID(),
) {
  const body = JSON.stringify({
    entity: 'event',
    event,
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: orderId,
          status: 'captured',
          email: 'never-stored@example.test',
        },
      },
    },
  });
  return request(app)
    .post(`/api/v1/webhooks/payments/razorpay/${merchantId}`)
    .set('Content-Type', 'application/json')
    .set('X-Razorpay-Signature', sign('synthetic-webhook-secret', body))
    .set('X-Razorpay-Event-Id', eventId)
    .send(body);
}

let owner: Identity;
let reviewer: Identity;
let doctor: Identity;
let clinic: { organizationId: string; facilityId: string };
let affiliationId: string;

beforeAll(async () => {
  await startDatabase();
  setPaymentGateway(gateway);
  owner = await account();
  reviewer = await platformAdmin();
  doctor = await account();
  clinic = await provider(owner, reviewer);
  ({ affiliationId } = await verifiedDoctor(doctor, reviewer, owner, clinic));
});
afterAll(stopDatabase);

describe('Resource-safe booking', () => {
  it('allows exactly one of many concurrent holds for the same doctor interval', async () => {
    const offering = await bookableOffering(owner, clinic, affiliationId);
    const startAt = slot(2, 600);
    const contenders = await Promise.all(
      Array.from({ length: 12 }, async () => {
        const identity = await account();
        const profile = await patient(identity);
        return { identity, patientId: profile.id };
      }),
    );
    const results = await Promise.allSettled(
      contenders.map(({ identity, patientId }) =>
        appointments.createHold(
          identity.actor,
          {
            patientId,
            offeringId: offering.offeringId,
            offeringVersion: offering.version,
            priceId: offering.priceId,
            startAt,
          },
          key(),
        ),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    for (const result of results.filter((r) => r.status === 'rejected'))
      expect((result as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409 });
    const availability = await scheduling.availability(offering.offeringId, startAt.slice(0, 10));
    expect(availability.slots.length).toBeGreaterThan(0);
  });

  it('runs pay-at-provider booking through queue, consultation, invoice, cash receipt and balanced ledger', async () => {
    const offering = await bookableOffering(owner, clinic, affiliationId, {
      amountMinor: 40_000,
      taxBasisPoints: 1_800,
    });
    const patientAccount = await account();
    const profile = await patient(patientAccount);
    const startAt = slot(1, 630);
    const hold = await appointments.createHold(
      patientAccount.actor,
      {
        patientId: profile.id,
        offeringId: offering.offeringId,
        offeringVersion: offering.version,
        priceId: offering.priceId,
        startAt,
      },
      key(),
    );
    await expect(
      appointments.createHold(
        patientAccount.actor,
        {
          patientId: profile.id,
          offeringId: offering.offeringId,
          offeringVersion: offering.version + 1,
          priceId: offering.priceId,
          startAt: slot(1, 660),
        },
        key(),
      ),
    ).rejects.toMatchObject({ code: 'QUOTE_CHANGED' });
    const confirmed = await appointments.confirmAppointment(
      patientAccount.actor,
      hold.id,
      0,
      key(),
    );
    const booked = await appointments.getAppointment(patientAccount.actor, hold.id);
    expect(booked).toMatchObject({
      status: 'CONFIRMED',
      bookingNumber: expect.stringMatching(/^APT-/),
    });
    expect(booked.registrationId).toBeDefined();
    // Check-in opens two hours before the visit; move the synthetic appointment into that window.
    const soon = new Date(Date.now() + 30 * 60_000);
    await Appointment.updateOne(
      { _id: hold.id },
      { $set: { startAt: soon, endAt: new Date(soon.getTime() + 30 * 60_000) } },
    );
    const checkedIn = await appointments.transitionAppointment(
      owner.actor,
      clinic.organizationId,
      hold.id,
      'check-in',
      confirmed.version,
      undefined,
      key(),
    );
    const token = await QueueEntry.findOne({ appointmentId: hold.id });
    expect(token).toMatchObject({ tokenNumber: 1, status: 'WAITING' });
    const listed = await queue.listQueue(owner.actor, clinic.organizationId, {
      facilityId: clinic.facilityId,
      limit: 25,
    });
    expect(listed.items.map((item) => item.appointmentId)).toContain(hold.id);
    await expect(
      appointments.transitionAppointment(
        owner.actor,
        clinic.organizationId,
        hold.id,
        'start',
        checkedIn.version,
        undefined,
        key(),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    const started = await appointments.transitionAppointment(
      doctor.actor,
      clinic.organizationId,
      hold.id,
      'start',
      checkedIn.version,
      undefined,
      key(),
    );
    await appointments.transitionAppointment(
      doctor.actor,
      clinic.organizationId,
      hold.id,
      'complete',
      started.version,
      undefined,
      key(),
    );
    expect(
      await ResourceClaim.countDocuments({ appointmentId: hold.id, state: { $ne: 'RELEASED' } }),
    ).toBe(0);

    const registration = (await PatientRegistration.findOne({
      organizationId: clinic.organizationId,
      patientId: profile.id,
    }))!;
    const draft = await invoices.createInvoice(
      owner.actor,
      clinic.organizationId,
      {
        patientRegistrationId: String(registration._id),
        appointmentId: hold.id,
        chargeItemIds: [],
        lines: [],
        dueInDays: 0,
      },
      key(),
    );
    await expect(
      invoices.createInvoice(
        owner.actor,
        clinic.organizationId,
        {
          patientRegistrationId: String(registration._id),
          appointmentId: hold.id,
          chargeItemIds: [],
          lines: [],
          dueInDays: 0,
        },
        key(),
      ),
    ).rejects.toBeDefined();
    const issued = await invoices.issueInvoice(
      owner.actor,
      clinic.organizationId,
      draft.id,
      draft.version,
      key(),
    );
    const invoice = await invoices.getInvoice(owner.actor, clinic.organizationId, draft.id);
    expect(invoice).toMatchObject({
      status: 'ISSUED',
      totalMinor: 47_200,
      taxMinor: 7_200,
      outstandingMinor: 47_200,
    });
    expect(invoice.number).toMatch(/^INV\/\d{4}-\d{2}\/\d{6}$/);
    expect(issued.version).toBeGreaterThan(draft.version);
    await expect(
      invoices.recordOfflinePayment(
        owner.actor,
        clinic.organizationId,
        {
          patientRegistrationId: String(registration._id),
          method: 'CASH',
          amountMinor: 50_000,
          invoiceId: draft.id,
        },
        key(),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    await invoices.recordOfflinePayment(
      owner.actor,
      clinic.organizationId,
      {
        patientRegistrationId: String(registration._id),
        method: 'CASH',
        amountMinor: 47_200,
        invoiceId: draft.id,
      },
      key(),
    );
    expect(await invoices.getInvoice(owner.actor, clinic.organizationId, draft.id)).toMatchObject({
      outstandingMinor: 0,
      allocatedMinor: 47_200,
    });
    const balance = await trialBalance(owner.actor, clinic.organizationId);
    expect(balance.balanced).toBe(true);
    const receivable = balance.accounts.find((row) => row.code === '1200')!;
    expect(receivable.debitMinor - receivable.creditMinor).toBe(0);
  });
});

describe('Razorpay prepaid booking', () => {
  let merchantId: string;
  let prepaid: Awaited<ReturnType<typeof bookableOffering>>;

  beforeAll(async () => {
    const merchant = await merchants.registerMerchant(
      owner.actor,
      clinic.organizationId,
      {
        provider: 'RAZORPAY',
        label: 'Main account',
        keyId: 'rzp_test_SyntheticKey1',
        keySecretRef: 'env:RAZORPAY_KEY_SECRET_TEST',
        webhookSecretRef: 'env:RAZORPAY_WEBHOOK_SECRET_TEST',
      },
      key(),
    );
    merchantId = merchant.id;
    await expect(
      merchants.decideMerchant(
        owner.actor,
        merchantId,
        { expectedVersion: 0, status: 'ACTIVE', reason: 'Self approval attempt' },
        key(),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    await merchants.decideMerchant(
      reviewer.actor,
      merchantId,
      { expectedVersion: 0, status: 'ACTIVE', reason: 'Independent KYC checked' },
      key(),
    );
    prepaid = await bookableOffering(owner, clinic, affiliationId, {
      paymentPolicy: 'PREPAY',
      amountMinor: 60_000,
    });
  });

  async function prepaidHold(days: number, minute: number) {
    const identity = await account();
    const profile = await patient(identity);
    const hold = await appointments.createHold(
      identity.actor,
      {
        patientId: profile.id,
        offeringId: prepaid.offeringId,
        offeringVersion: prepaid.version,
        priceId: prepaid.priceId,
        startAt: slot(days, minute),
      },
      key(),
    );
    return { identity, profile, hold };
  }

  it('confirms only through a verified capture, deduplicates webhooks and refunds a timely cancellation', async () => {
    const { identity, hold } = await prepaidHold(5, 600);
    await expect(
      appointments.confirmAppointment(identity.actor, hold.id, 0, key()),
    ).rejects.toMatchObject({ code: 'PAYMENT_NOT_READY' });
    const intent = await payments.createAppointmentPaymentIntent(identity.actor, hold.id, key());
    expect(intent).toMatchObject({
      status: 'READY',
      amountMinor: 60_000,
      checkout: { keyId: 'rzp_test_SyntheticKey1' },
    });
    const again = await payments.createAppointmentPaymentIntent(identity.actor, hold.id, key());
    expect(again.id).toBe(intent.id);
    const remote = gateway.pay(intent.checkout!.orderId);

    const forged = await request(app)
      .post(`/api/v1/webhooks/payments/razorpay/${merchantId}`)
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', 'a'.repeat(64))
      .send(JSON.stringify({ event: 'payment.captured', payload: {} }));
    expect(forged.status).toBe(401);

    const eventId = randomUUID();
    expect(
      (await webhook(merchantId, 'payment.captured', remote.id, remote.orderId, eventId)).status,
    ).toBe(200);
    expect(
      (await webhook(merchantId, 'payment.captured', remote.id, remote.orderId, eventId)).status,
    ).toBe(200);
    await inlineWebhookProcessing();
    await payments.processInbox();
    expect(
      await InboxEvent.countDocuments({ sourceAccount: merchantId, externalEventId: eventId }),
    ).toBe(1);
    expect(
      JSON.stringify(await InboxEvent.findOne({ externalEventId: eventId }).lean()),
    ).not.toContain('never-stored');
    // A second, differently identified delivery of the same capture remains idempotent.
    await webhook(merchantId, 'order.paid', remote.id, remote.orderId);
    await inlineWebhookProcessing();
    await payments.processInbox();
    expect(await Payment.countDocuments({ providerPaymentId: remote.id })).toBe(1);

    const confirmed = await appointments.getAppointment(identity.actor, hold.id);
    expect(confirmed.status).toBe('CONFIRMED');
    const invoice = (await Invoice.findOne({ appointmentId: hold.id }))!;
    expect(invoice).toMatchObject({ status: 'ISSUED', totalMinor: 60_000, allocatedMinor: 60_000 });
    expect((await PaymentIntent.findById(intent.id))!.outcome).toBe('CONFIRMED');

    await appointments.cancelAppointment(
      identity.actor,
      hold.id,
      { expectedVersion: confirmed.version, reason: 'Patient cannot attend' },
      key(),
    );
    const refund = (await Refund.findOne({ operationKey: `cancel:${hold.id}` }))!;
    expect(refund).toMatchObject({ status: 'REQUESTED', amountMinor: 60_000 });
    expect(await CreditNote.countDocuments({ invoiceId: invoice._id })).toBe(1);
    await payments.processRefunds();
    expect((await Refund.findById(refund._id))!.status).toBe('SUCCEEDED');
    const payment = (await Payment.findOne({ providerPaymentId: remote.id }))!;
    expect(payment).toMatchObject({
      refundedMinor: 60_000,
      refundReservedMinor: 0,
      allocatedMinor: 0,
    });
    expect(gateway.refunds.filter((row) => row.paymentId === remote.id)).toHaveLength(1);
    expect((await trialBalance(owner.actor, clinic.organizationId)).balanced).toBe(true);
  });

  it('records a capture after hold expiry as a refund obligation without reviving the booking', async () => {
    const { identity, hold } = await prepaidHold(6, 630);
    const intent = await payments.createAppointmentPaymentIntent(identity.actor, hold.id, key());
    await Appointment.updateOne(
      { _id: hold.id },
      { $set: { holdExpiresAt: new Date(Date.now() - 1000) } },
    );
    await ResourceClaim.updateMany(
      { appointmentId: hold.id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    expect(await appointments.expireAppointmentHolds()).toBeGreaterThanOrEqual(1);
    const remote = gateway.pay(intent.checkout!.orderId);
    await webhook(merchantId, 'payment.captured', remote.id, remote.orderId);
    await inlineWebhookProcessing();
    await payments.processInbox();
    expect((await Appointment.findById(hold.id))!).toMatchObject({
      status: 'EXPIRED',
      refundRequired: true,
    });
    const payment = (await Payment.findOne({ providerPaymentId: remote.id }))!;
    expect(payment).toMatchObject({
      status: 'CAPTURED',
      refundReservedMinor: 60_000,
      allocatedMinor: 0,
    });
    expect((await PaymentIntent.findById(intent.id))!.outcome).toBe('REFUND_REQUIRED');
    await payments.processRefunds();
    expect((await Payment.findById(payment._id))!.refundedMinor).toBe(60_000);
  });

  it('applies the late-cancellation refund share from the accepted policy snapshot', async () => {
    const { identity, hold } = await prepaidHold(1, 900);
    const intent = await payments.createAppointmentPaymentIntent(identity.actor, hold.id, key());
    const remote = gateway.pay(intent.checkout!.orderId);
    await payments.verifyCheckout(identity.actor, intent.id, {
      orderId: remote.orderId!,
      paymentId: remote.id,
      signature: sign('synthetic-key-secret', `${remote.orderId}|${remote.id}`),
    });
    const booked = await appointments.getAppointment(identity.actor, hold.id);
    expect(booked.status).toBe('CONFIRMED');
    // Move the visit inside the 24-hour notice window so the late share applies.
    const soon = new Date(Date.now() + 3 * 3600_000);
    await Appointment.updateOne({ _id: hold.id }, { $set: { startAt: soon } });
    await appointments.cancelAppointment(
      identity.actor,
      hold.id,
      { expectedVersion: booked.version, reason: 'Late patient cancellation' },
      key(),
    );
    // Within the 24-hour notice window the snapshot grants a 50% refund.
    expect((await Refund.findOne({ operationKey: `cancel:${hold.id}` }))!.amountMinor).toBe(30_000);
    const invoice = (await Invoice.findOne({ appointmentId: hold.id }))!;
    expect(invoice).toMatchObject({ creditedMinor: 30_000, allocatedMinor: 30_000 });
  });
});
