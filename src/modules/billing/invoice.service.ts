import { randomUUID } from 'node:crypto';
import type { ClientSession, Types } from 'mongoose';
import type { z } from 'zod';
import type { CommandActor } from '../../shared/domain/healthcare.js';
import { command, conflict } from '../../shared/application/command.js';
import {
  actorRef,
  before,
  fiscalYear,
  formatNumber,
  nextNumber,
  pageOf,
  scoped,
  type OperationActor,
} from '../../shared/application/scope.js';
import { taxMinor } from '../../shared/domain/money.js';
import { ApiError } from '../../utils/api-error.js';
import { authorizeOrganization } from '../access/access.service.js';
import { authorizePatient } from '../patients/patient.service.js';
import { PatientRegistration } from '../patients/patient.model.js';
import { Organization } from '../organizations/organization.model.js';
import { Appointment } from '../appointments/appointment.model.js';
import { recordChange, recordRead } from '../operations/operation.service.js';
import {
  ChargeItem,
  CreditNote,
  Invoice,
  InvoiceItem,
  Payment,
  PaymentAllocation,
  Refund,
} from './billing.model.js';
import { postJournal } from './ledger.service.js';
import type {
  allocationInput,
  chargeQuery,
  creditNoteInput,
  invoiceInput,
  invoiceLineInput,
  invoiceQuery,
  offlinePaymentInput,
  paymentQuery,
  refundInput,
  voidInvoiceInput,
} from './billing.validation.js';

export type InvoiceDocument = ReturnType<typeof Invoice.hydrate>;
export type PaymentDocument = ReturnType<typeof Payment.hydrate>;
export type RefundDocument = ReturnType<typeof Refund.hydrate>;
type Line = z.infer<typeof invoiceLineInput> & { chargeItemId?: Types.ObjectId };

/** Deterministic per-line arithmetic in integer minor units. */
export function lineAmounts(line: {
  quantity: number;
  unitPriceMinor: number;
  discountMinor: number;
  taxBasisPoints: number;
}) {
  const gross = line.quantity * line.unitPriceMinor;
  if (!Number.isSafeInteger(gross)) throw ApiError.badRequest('Line amount is too large');
  const net = gross - line.discountMinor;
  const tax = taxMinor(net, line.taxBasisPoints);
  return { gross, net, tax, total: net + tax };
}

export const outstanding = (invoice: {
  totalMinor: number;
  creditedMinor: number;
  allocatedMinor: number;
}) => invoice.totalMinor - invoice.creditedMinor - invoice.allocatedMinor;
export const unapplied = (payment: {
  amountMinor: number;
  allocatedMinor: number;
  refundedMinor: number;
  refundReservedMinor: number;
}) =>
  payment.amountMinor -
  payment.allocatedMinor -
  payment.refundedMinor -
  payment.refundReservedMinor;

async function registrationInScope(
  organizationId: string,
  registrationId: string,
  session?: ClientSession,
) {
  const registration = await PatientRegistration.findOne({
    _id: registrationId,
    organizationId,
    status: 'ACTIVE',
  }).session(session ?? null);
  if (!registration) throw ApiError.notFound('Patient registration is unavailable');
  return registration;
}

/** Creates a draft invoice and its lines. Lines may change only while the parent is a draft. */
export async function createDraftInvoice(
  actor: OperationActor,
  data: {
    organizationId: string;
    patientRegistrationId: string;
    facilityId?: string;
    appointmentId?: string;
    lines: Line[];
    dueInDays: number;
  },
  session: ClientSession,
) {
  if (!data.lines.length) throw ApiError.badRequest('An invoice needs at least one line');
  if (data.lines.length > 500) throw ApiError.badRequest('An invoice can have at most 500 lines');
  const organization = await Organization.findById(data.organizationId).session(session);
  if (!organization) throw ApiError.notFound('Organization is unavailable');
  const registration = await registrationInScope(
    data.organizationId,
    data.patientRegistrationId,
    session,
  );
  const who = actorRef(actor);
  let subtotal = 0;
  let discount = 0;
  let tax = 0;
  const computed = data.lines.map((line, index) => {
    const amounts = lineAmounts(line);
    subtotal += amounts.gross;
    discount += line.discountMinor;
    tax += amounts.tax;
    return { line, index, amounts };
  });
  const [invoice] = await Invoice.create(
    [
      {
        organizationId: data.organizationId,
        fiscalPeriod: fiscalYear(),
        seller: {
          organizationId: organization._id,
          name: organization.legalName,
          address: organization.legalAddress,
        },
        buyer: {
          kind: 'PATIENT',
          id: registration.patientId,
          name: registration.demographicSnapshot.name.display,
        },
        patientId: registration.patientId,
        patientRegistrationId: registration._id,
        facilityId: data.facilityId,
        appointmentId: data.appointmentId,
        appointmentKey: data.appointmentId,
        lineCount: computed.length,
        subtotalMinor: subtotal,
        discountMinor: discount,
        taxMinor: tax,
        totalMinor: subtotal - discount + tax,
        dueAt: new Date(Date.now() + data.dueInDays * 86400_000),
        createdBy: who,
        updatedBy: who,
      },
    ],
    { session },
  );
  await InvoiceItem.create(
    computed.map(({ line, index, amounts }) => ({
      organizationId: data.organizationId,
      invoiceId: invoice!._id,
      lineNumber: index + 1,
      chargeItemId: line.chargeItemId,
      description: line.description,
      serviceCode: line.serviceCode,
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      discountMinor: line.discountMinor,
      taxBasisPoints: line.taxBasisPoints,
      netMinor: amounts.net,
      taxMinor: amounts.tax,
      totalMinor: amounts.total,
      createdBy: who,
      updatedBy: who,
    })),
    { session, ordered: true },
  );
  await recordChange(
    actor,
    {
      organizationId: data.organizationId,
      patientId: String(registration.patientId),
      action: 'InvoiceDrafted',
      resourceType: 'invoice',
      resourceId: String(invoice!._id),
      version: 0,
    },
    session,
  );
  return invoice!;
}

/** Freezes the invoice and its lines, assigns a never-reused number and posts receivables. */
export async function issueDraft(
  actor: OperationActor,
  invoice: InvoiceDocument,
  session: ClientSession,
) {
  if (invoice.status !== 'DRAFT') conflict('Only draft invoices can be issued');
  // Locks every line against concurrent draft edits before sealing.
  const lines = await InvoiceItem.find({ invoiceId: invoice._id }).session(session);
  if (lines.length !== invoice.lineCount) conflict('Invoice lines changed; reload and retry');
  const sequence = await nextNumber(
    invoice.organizationId,
    `INVOICE:${invoice.fiscalPeriod}`,
    session,
  );
  invoice.number = `INV/${invoice.fiscalPeriod}/${String(sequence).padStart(6, '0')}`;
  invoice.status = 'ISSUED';
  invoice.issuedAt = new Date();
  invoice.updatedBy = actorRef(actor);
  const journal = await postJournal(
    actor,
    invoice.organizationId,
    { type: 'invoice', id: String(invoice._id) },
    `invoice-issue:${invoice._id}`,
    `Invoice ${invoice.number}`,
    [
      { account: 'RECEIVABLE', debitMinor: invoice.totalMinor },
      { account: 'REVENUE', creditMinor: invoice.totalMinor - invoice.taxMinor },
      { account: 'TAX', creditMinor: invoice.taxMinor },
    ],
    session,
  );
  invoice.journalId = journal?._id;
  await invoice.save({ session });
  await ChargeItem.updateMany(
    { _id: { $in: lines.map((line) => line.chargeItemId).filter(Boolean) }, status: 'UNBILLED' },
    { $set: { status: 'BILLED', invoiceId: invoice._id } },
    { session },
  );
  await recordChange(
    actor,
    {
      organizationId: String(invoice.organizationId),
      patientId: invoice.patientId ? String(invoice.patientId) : undefined,
      action: 'InvoiceIssued',
      resourceType: 'invoice',
      resourceId: String(invoice._id),
      version: invoice.version,
    },
    session,
  );
}

/** Posts the receipt journal for a captured payment (cash/bank or gateway clearing). */
export async function postReceipt(
  actor: OperationActor,
  payment: PaymentDocument,
  session: ClientSession,
) {
  await postJournal(
    actor,
    payment.organizationId,
    { type: 'payment', id: String(payment._id) },
    `payment-receipt:${payment._id}`,
    payment.receiptNumber ? `Receipt ${payment.receiptNumber}` : 'Gateway capture',
    [
      {
        account: payment.method === 'GATEWAY' ? 'GATEWAY_CLEARING' : 'CASH',
        debitMinor: payment.amountMinor,
      },
      { account: 'ADVANCES', creditMinor: payment.amountMinor },
    ],
    session,
  );
}

/** Applies payment funds to an issued invoice under both parents' guards. */
export async function allocate(
  actor: OperationActor,
  payment: PaymentDocument,
  invoice: InvoiceDocument,
  amountMinor: number,
  operationKey: string,
  session: ClientSession,
) {
  if (String(payment.organizationId) !== String(invoice.organizationId))
    throw ApiError.badRequest('Payment and invoice belong to different ledgers');
  if (payment.status !== 'CAPTURED' || invoice.status !== 'ISSUED')
    conflict('Only captured payments and issued invoices can be allocated');
  if (
    invoice.patientId &&
    payment.patientId &&
    String(invoice.patientId) !== String(payment.patientId)
  )
    throw ApiError.badRequest('Payment and invoice belong to different patients');
  if (amountMinor > unapplied(payment)) conflict('The payment has insufficient unapplied funds');
  if (amountMinor > outstanding(invoice)) conflict('The amount exceeds the invoice balance');
  const journal = await postJournal(
    actor,
    invoice.organizationId,
    { type: 'paymentAllocation', id: operationKey },
    `allocation:${operationKey}`,
    `Apply payment to ${invoice.number}`,
    [
      { account: 'ADVANCES', debitMinor: amountMinor },
      { account: 'RECEIVABLE', creditMinor: amountMinor },
    ],
    session,
  );
  const [allocation] = await PaymentAllocation.create(
    [
      {
        organizationId: invoice.organizationId,
        paymentId: payment._id,
        invoiceId: invoice._id,
        amountMinor,
        kind: 'APPLY',
        operationKey,
        journalId: journal!._id,
        createdBy: actorRef(actor),
      },
    ],
    { session },
  );
  payment.allocatedMinor += amountMinor;
  invoice.allocatedMinor += amountMinor;
  payment.updatedBy = actorRef(actor);
  invoice.updatedBy = actorRef(actor);
  await payment.save({ session });
  await invoice.save({ session });
  await recordChange(
    actor,
    {
      organizationId: String(invoice.organizationId),
      patientId: invoice.patientId ? String(invoice.patientId) : undefined,
      action: 'PaymentAllocated',
      resourceType: 'paymentAllocation',
      resourceId: String(allocation!._id),
      version: 0,
    },
    session,
  );
  return allocation!;
}

/** Reverses the most recent applications on an invoice until the amount is freed. */
async function reverseAllocations(
  actor: OperationActor,
  invoice: InvoiceDocument,
  amountMinor: number,
  operationKey: string,
  session: ClientSession,
) {
  const history = await PaymentAllocation.find({ invoiceId: invoice._id })
    .sort({ _id: -1 })
    .session(session);
  const reversed = new Map<string, number>();
  for (const row of history)
    if (row.kind === 'REVERSE' && row.reversesId)
      reversed.set(
        String(row.reversesId),
        (reversed.get(String(row.reversesId)) ?? 0) + row.amountMinor,
      );
  let remaining = amountMinor;
  for (const application of history) {
    if (remaining === 0) break;
    if (application.kind !== 'APPLY') continue;
    const available = application.amountMinor - (reversed.get(String(application._id)) ?? 0);
    if (available <= 0) continue;
    const portion = Math.min(available, remaining);
    const payment = await Payment.findById(application.paymentId).session(session);
    if (!payment) throw new Error('Allocation payment is missing');
    const key = `${operationKey}:${application._id}`;
    const journal = await postJournal(
      actor,
      invoice.organizationId,
      { type: 'paymentAllocation', id: key },
      `allocation:${key}`,
      `Reverse application on ${invoice.number}`,
      [
        { account: 'RECEIVABLE', debitMinor: portion },
        { account: 'ADVANCES', creditMinor: portion },
      ],
      session,
    );
    await PaymentAllocation.create(
      [
        {
          organizationId: invoice.organizationId,
          paymentId: payment._id,
          invoiceId: invoice._id,
          amountMinor: portion,
          kind: 'REVERSE',
          reversesId: application._id,
          operationKey: key,
          journalId: journal!._id,
          createdBy: actorRef(actor),
        },
      ],
      { session },
    );
    payment.allocatedMinor -= portion;
    payment.updatedBy = actorRef(actor);
    await payment.save({ session });
    invoice.allocatedMinor -= portion;
    remaining -= portion;
  }
  if (remaining > 0) conflict('Not enough allocated funds to reverse');
}

/**
 * Issues an immutable credit note. Liability correction is separate from moving money: a refund
 * is a distinct operation. With `reverse`, the credited amount is first freed from allocations.
 */
export async function creditInvoice(
  actor: OperationActor,
  invoice: InvoiceDocument,
  lines: Array<{ lineNumber: number; totalMinor: number }>,
  reason: string,
  operationKey: string,
  reverse: boolean,
  session: ClientSession,
) {
  if (invoice.status !== 'ISSUED') conflict('Only issued invoices can be credited');
  const total = lines.reduce((sum, line) => sum + line.totalMinor, 0);
  if (reverse) await reverseAllocations(actor, invoice, total, `credit:${operationKey}`, session);
  if (total > outstanding(invoice))
    conflict('Credit exceeds the unpaid balance; reverse allocations first');
  const noteLines = [];
  let net = 0;
  let tax = 0;
  for (const requested of lines) {
    const item = await InvoiceItem.findOne({
      invoiceId: invoice._id,
      lineNumber: requested.lineNumber,
    }).session(session);
    if (!item) throw ApiError.notFound(`Invoice line ${requested.lineNumber} is unavailable`);
    if (item.creditedMinor + requested.totalMinor > item.totalMinor)
      conflict(`Line ${requested.lineNumber} cannot be credited beyond its total`);
    const lineTax = item.totalMinor
      ? Number((BigInt(requested.totalMinor) * BigInt(item.taxMinor)) / BigInt(item.totalMinor))
      : 0;
    item.creditedMinor += requested.totalMinor;
    item.updatedBy = actorRef(actor);
    await item.save({ session });
    noteLines.push({
      invoiceLineNumber: requested.lineNumber,
      netMinor: requested.totalMinor - lineTax,
      taxMinor: lineTax,
      totalMinor: requested.totalMinor,
    });
    net += requested.totalMinor - lineTax;
    tax += lineTax;
  }
  const number = formatNumber(
    'CN',
    await nextNumber(invoice.organizationId, 'CREDIT_NOTE', session),
  );
  const noteId = randomUUID();
  const journal = await postJournal(
    actor,
    invoice.organizationId,
    { type: 'creditNote', id: noteId },
    `credit-note:${operationKey}`,
    `Credit note ${number}`,
    [
      { account: 'REVENUE', debitMinor: net },
      { account: 'TAX', debitMinor: tax },
      { account: 'RECEIVABLE', creditMinor: total },
    ],
    session,
  );
  const [note] = await CreditNote.create(
    [
      {
        organizationId: invoice.organizationId,
        invoiceId: invoice._id,
        number,
        reason,
        lines: noteLines,
        totalMinor: total,
        issuedAt: new Date(),
        journalId: journal!._id,
        createdBy: actorRef(actor),
      },
    ],
    { session },
  );
  invoice.creditedMinor += total;
  invoice.updatedBy = actorRef(actor);
  await invoice.save({ session });
  await recordChange(
    actor,
    {
      organizationId: String(invoice.organizationId),
      patientId: invoice.patientId ? String(invoice.patientId) : undefined,
      action: 'CreditNoteIssued',
      resourceType: 'creditNote',
      resourceId: String(note!._id),
      version: 0,
      reason,
    },
    session,
  );
  return note!;
}

/**
 * Reserves refundable funds before any network call. Offline refunds are paid out by the
 * recording staff member and complete immediately; gateway refunds are completed by a worker.
 */
export async function reserveRefund(
  actor: OperationActor,
  payment: PaymentDocument,
  amountMinor: number,
  reason: string,
  operationKey: string,
  session: ClientSession,
  creditNoteId?: Types.ObjectId,
) {
  const existing = await Refund.findOne({
    organizationId: payment.organizationId,
    operationKey,
  }).session(session);
  if (existing) return existing;
  if (payment.status !== 'CAPTURED') conflict('Only captured payments can be refunded');
  if (amountMinor > unapplied(payment))
    conflict('Refund exceeds unapplied funds; credit and reverse the invoice allocation first');
  payment.refundReservedMinor += amountMinor;
  payment.updatedBy = actorRef(actor);
  await payment.save({ session });
  const who = actorRef(actor);
  const [refund] = await Refund.create(
    [
      {
        organizationId: payment.organizationId,
        paymentId: payment._id,
        creditNoteId,
        amountMinor,
        reason,
        requestedBy: who,
        operationKey,
        createdBy: who,
        updatedBy: who,
      },
    ],
    { session },
  );
  await recordChange(
    actor,
    {
      organizationId: String(payment.organizationId),
      patientId: payment.patientId ? String(payment.patientId) : undefined,
      action: 'RefundRequested',
      resourceType: 'refund',
      resourceId: String(refund!._id),
      version: 0,
      reason,
    },
    session,
  );
  if (payment.method !== 'GATEWAY')
    await completeRefund(actor, refund!, payment, session, { success: true });
  return refund!;
}

/** Releases or consumes the reservation exactly once, with the matching ledger entry. */
export async function completeRefund(
  actor: OperationActor,
  refund: RefundDocument,
  payment: PaymentDocument,
  session: ClientSession,
  outcome: { success: boolean; providerRefundId?: string; failureCode?: string },
) {
  if (refund.status === 'SUCCEEDED' || refund.status === 'FAILED') return;
  payment.refundReservedMinor -= refund.amountMinor;
  if (outcome.success) payment.refundedMinor += refund.amountMinor;
  payment.updatedBy = actorRef(actor);
  await payment.save({ session });
  refund.status = outcome.success ? 'SUCCEEDED' : 'FAILED';
  refund.completedAt = new Date();
  if (outcome.providerRefundId) refund.providerRefundId = outcome.providerRefundId;
  refund.failureCode = outcome.failureCode;
  refund.updatedBy = actorRef(actor);
  await refund.save({ session });
  if (outcome.success)
    await postJournal(
      actor,
      payment.organizationId,
      { type: 'refund', id: String(refund._id) },
      `refund:${refund._id}`,
      'Refund paid',
      [
        { account: 'ADVANCES', debitMinor: refund.amountMinor },
        {
          account: payment.method === 'GATEWAY' ? 'GATEWAY_CLEARING' : 'CASH',
          creditMinor: refund.amountMinor,
        },
      ],
      session,
    );
  await recordChange(
    actor,
    {
      organizationId: String(payment.organizationId),
      patientId: payment.patientId ? String(payment.patientId) : undefined,
      action: outcome.success ? 'RefundSucceeded' : 'RefundFailed',
      resourceType: 'refund',
      resourceId: String(refund._id),
      version: refund.version,
    },
    session,
  );
}

// ── HTTP commands ────────────────────────────────────────────────────────────

export async function createInvoice(
  actor: CommandActor,
  organizationId: string,
  input: z.infer<typeof invoiceInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'billing.manage', {
    facilityId: input.facilityId,
  });
  return command(actor, organizationId, 'invoice.create', key, input, async (session) => {
    await scoped(actor, organizationId, 'billing.manage', session, {
      facilityId: input.facilityId,
    });
    const registration = await registrationInScope(
      organizationId,
      input.patientRegistrationId,
      session,
    );
    const lines: Line[] = [...input.lines];
    if (input.appointmentId) {
      const appointment = await Appointment.findOne({
        _id: input.appointmentId,
        organizationId,
        patientId: registration.patientId,
        status: {
          $in: ['CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED', 'DISCONTINUED', 'NO_SHOW'],
        },
      }).session(session);
      if (!appointment) throw ApiError.notFound('Billable appointment is unavailable');
      if (!lines.length)
        lines.push({
          description: appointment.offeringSnapshot.name,
          quantity: 1,
          unitPriceMinor: appointment.priceSnapshot.amountMinor,
          discountMinor: 0,
          taxBasisPoints: appointment.priceSnapshot.taxBasisPoints ?? 0,
        });
    }
    const charges = await ChargeItem.find({
      _id: { $in: input.chargeItemIds },
      organizationId,
      patientRegistrationId: registration._id,
      status: 'UNBILLED',
    }).session(session);
    if (charges.length !== input.chargeItemIds.length)
      throw ApiError.notFound('A charge is unavailable or billed');
    for (const charge of charges)
      lines.push({
        description: charge.description,
        serviceCode: charge.serviceCode ?? undefined,
        quantity: charge.quantity,
        unitPriceMinor: charge.unitPriceMinor,
        discountMinor: 0,
        taxBasisPoints: charge.taxBasisPoints,
        chargeItemId: charge._id,
      });
    const invoice = await createDraftInvoice(
      actor,
      {
        organizationId,
        patientRegistrationId: input.patientRegistrationId,
        facilityId: input.facilityId,
        appointmentId: input.appointmentId,
        lines,
        dueInDays: input.dueInDays,
      },
      session,
    );
    return { id: String(invoice._id), version: invoice.version };
  });
}

async function invoiceForUpdate(
  organizationId: string,
  invoiceId: string,
  expectedVersion: number,
  session: ClientSession,
) {
  const invoice = await Invoice.findOne({
    _id: invoiceId,
    organizationId,
    version: expectedVersion,
  }).session(session);
  if (!invoice) conflict();
  return invoice;
}

export async function issueInvoice(
  actor: CommandActor,
  organizationId: string,
  invoiceId: string,
  expectedVersion: number,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'billing.manage');
  return command(
    actor,
    organizationId,
    `invoice.issue:${invoiceId}`,
    key,
    { expectedVersion },
    async (session) => {
      const invoice = await invoiceForUpdate(organizationId, invoiceId, expectedVersion, session);
      await scoped(actor, organizationId, 'billing.manage', session, {
        facilityId: invoice.facilityId ? String(invoice.facilityId) : undefined,
      });
      await issueDraft(actor, invoice, session);
      return { id: invoiceId, version: invoice.version };
    },
  );
}

/** Only drafts can be discarded; an issued invoice is corrected through credit notes. */
export async function voidInvoice(
  actor: CommandActor,
  organizationId: string,
  invoiceId: string,
  input: z.infer<typeof voidInvoiceInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'billing.manage');
  return command(
    actor,
    organizationId,
    `invoice.void:${invoiceId}`,
    key,
    input,
    async (session) => {
      const invoice = await invoiceForUpdate(
        organizationId,
        invoiceId,
        input.expectedVersion,
        session,
      );
      await scoped(actor, organizationId, 'billing.manage', session);
      if (invoice.status !== 'DRAFT') conflict('Issued invoices are corrected with credit notes');
      invoice.status = 'VOID';
      invoice.appointmentKey = undefined;
      invoice.updatedBy = { kind: 'USER', id: actor.userId };
      await invoice.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          action: 'InvoiceDiscarded',
          resourceType: 'invoice',
          resourceId: invoiceId,
          version: invoice.version,
          reason: input.reason,
        },
        session,
      );
      return { id: invoiceId, version: invoice.version };
    },
  );
}

export async function recordOfflinePayment(
  actor: CommandActor,
  organizationId: string,
  input: z.infer<typeof offlinePaymentInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'payments.collect');
  return command(actor, organizationId, 'payment.offline', key, input, async (session) => {
    await scoped(actor, organizationId, 'payments.collect', session, { activeProvider: true });
    const registration = await registrationInScope(
      organizationId,
      input.patientRegistrationId,
      session,
    );
    const receiptNumber = formatNumber(
      'RCPT',
      await nextNumber(organizationId, 'RECEIPT', session),
    );
    const who = { kind: 'USER' as const, id: actor.userId };
    const [payment] = await Payment.create(
      [
        {
          organizationId,
          method: input.method,
          status: 'CAPTURED',
          amountMinor: input.amountMinor,
          patientId: registration.patientId,
          patientRegistrationId: registration._id,
          payerName: input.payerName,
          capturedAt: new Date(),
          receivedBy: actor.userId,
          offlineReference: input.offlineReference,
          receiptNumber,
          createdBy: who,
          updatedBy: who,
        },
      ],
      { session },
    );
    await postReceipt(actor, payment!, session);
    await recordChange(
      actor,
      {
        organizationId,
        patientId: String(registration.patientId),
        action: 'OfflinePaymentRecorded',
        resourceType: 'payment',
        resourceId: String(payment!._id),
        version: 0,
      },
      session,
    );
    if (input.invoiceId) {
      const invoice = await Invoice.findOne({ _id: input.invoiceId, organizationId }).session(
        session,
      );
      if (!invoice) throw ApiError.notFound('Invoice is unavailable');
      await allocate(
        actor,
        payment!,
        invoice,
        input.amountMinor,
        `receipt:${payment!._id}`,
        session,
      );
    }
    return { id: String(payment!._id), version: payment!.version };
  });
}

export async function allocatePayment(
  actor: CommandActor,
  organizationId: string,
  paymentId: string,
  input: z.infer<typeof allocationInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'billing.manage');
  return command(
    actor,
    organizationId,
    `payment.allocate:${paymentId}`,
    key,
    input,
    async (session) => {
      await scoped(actor, organizationId, 'billing.manage', session);
      const payment = await Payment.findOne({ _id: paymentId, organizationId }).session(session);
      const invoice = await Invoice.findOne({ _id: input.invoiceId, organizationId }).session(
        session,
      );
      if (!payment || !invoice) throw ApiError.notFound();
      const allocation = await allocate(
        actor,
        payment,
        invoice,
        input.amountMinor,
        `manual:${paymentId}:${key}`,
        session,
      );
      return { id: String(allocation._id), version: 0 };
    },
  );
}

export async function issueCreditNote(
  actor: CommandActor,
  organizationId: string,
  invoiceId: string,
  input: z.infer<typeof creditNoteInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'billing.manage');
  return command(
    actor,
    organizationId,
    `invoice.credit:${invoiceId}`,
    key,
    input,
    async (session) => {
      const invoice = await invoiceForUpdate(
        organizationId,
        invoiceId,
        input.expectedVersion,
        session,
      );
      await scoped(actor, organizationId, 'billing.manage', session);
      const note = await creditInvoice(
        actor,
        invoice,
        input.lines,
        input.reason,
        `${invoiceId}:${key}`,
        input.reverseAllocations,
        session,
      );
      return { id: String(note._id), version: 0 };
    },
  );
}

export async function requestRefund(
  actor: CommandActor,
  organizationId: string,
  paymentId: string,
  input: z.infer<typeof refundInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'payments.refund');
  return command(
    actor,
    organizationId,
    `payment.refund:${paymentId}`,
    key,
    input,
    async (session) => {
      await scoped(actor, organizationId, 'payments.refund', session);
      const payment = await Payment.findOne({ _id: paymentId, organizationId }).session(session);
      if (!payment) throw ApiError.notFound();
      const refund = await reserveRefund(
        actor,
        payment,
        input.amountMinor,
        input.reason,
        `manual:${paymentId}:${key}`,
        session,
      );
      return { id: String(refund._id), version: refund.version };
    },
  );
}

// ── Queries ──────────────────────────────────────────────────────────────────

function presentInvoice(row: InvoiceDocument) {
  return {
    id: String(row._id),
    number: row.number,
    status: row.status,
    kind: row.kind,
    fiscalPeriod: row.fiscalPeriod,
    seller: { name: row.seller.name, address: row.seller.address },
    buyer: { kind: row.buyer.kind, id: String(row.buyer.id), name: row.buyer.name },
    patientRegistrationId: row.patientRegistrationId
      ? String(row.patientRegistrationId)
      : undefined,
    appointmentId: row.appointmentId ? String(row.appointmentId) : undefined,
    issuedAt: row.issuedAt,
    dueAt: row.dueAt,
    currency: row.currency,
    subtotalMinor: row.subtotalMinor,
    discountMinor: row.discountMinor,
    taxMinor: row.taxMinor,
    totalMinor: row.totalMinor,
    creditedMinor: row.creditedMinor,
    allocatedMinor: row.allocatedMinor,
    outstandingMinor: outstanding(row),
    version: row.version,
  };
}

async function invoiceDetail(invoice: InvoiceDocument) {
  const [lines, notes, allocations] = await Promise.all([
    InvoiceItem.find({ invoiceId: invoice._id }).sort({ lineNumber: 1 }).lean(),
    CreditNote.find({ invoiceId: invoice._id }).sort({ _id: 1 }).lean(),
    PaymentAllocation.find({ invoiceId: invoice._id }).sort({ _id: 1 }).lean(),
  ]);
  return {
    ...presentInvoice(invoice),
    lines: lines.map((line) => ({
      lineNumber: line.lineNumber,
      description: line.description,
      serviceCode: line.serviceCode,
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      discountMinor: line.discountMinor,
      taxBasisPoints: line.taxBasisPoints,
      netMinor: line.netMinor,
      taxMinor: line.taxMinor,
      totalMinor: line.totalMinor,
      creditedMinor: line.creditedMinor,
    })),
    creditNotes: notes.map((note) => ({
      id: String(note._id),
      number: note.number,
      reason: note.reason,
      totalMinor: note.totalMinor,
      issuedAt: note.issuedAt,
    })),
    allocations: allocations.map((row) => ({
      id: String(row._id),
      paymentId: String(row.paymentId),
      kind: row.kind,
      amountMinor: row.amountMinor,
      createdAt: row.createdAt,
    })),
  };
}

export async function getInvoice(actor: CommandActor, organizationId: string, invoiceId: string) {
  await authorizeOrganization(actor, organizationId, 'billing.read');
  const invoice = await Invoice.findOne({ _id: invoiceId, organizationId });
  if (!invoice) throw ApiError.notFound();
  await recordRead(
    actor,
    'invoice',
    invoiceId,
    organizationId,
    invoice.patientId ? String(invoice.patientId) : undefined,
  );
  return invoiceDetail(invoice);
}

export async function listInvoices(
  actor: CommandActor,
  organizationId: string,
  query: z.infer<typeof invoiceQuery>,
) {
  await authorizeOrganization(actor, organizationId, 'billing.read');
  const rows = await Invoice.find({
    organizationId,
    ...(query.status ? { status: query.status } : {}),
    ...(query.patientRegistrationId ? { patientRegistrationId: query.patientRegistrationId } : {}),
    ...before(query.before),
  })
    .sort({ _id: -1 })
    .limit(query.limit + 1);
  return pageOf(rows, query.limit, (row) => presentInvoice(row));
}

/** Patient portal: issued invoices of an authorized patient profile across providers. */
export async function listPatientInvoices(
  actor: CommandActor,
  patientId: string,
  query: z.infer<typeof paymentQuery>,
) {
  await authorizePatient(actor, patientId, 'profile.read');
  const rows = await Invoice.find({ patientId, status: 'ISSUED', ...before(query.before) })
    .sort({ _id: -1 })
    .limit(query.limit + 1);
  return pageOf(rows, query.limit, (row) => presentInvoice(row));
}

export async function getPatientInvoice(actor: CommandActor, patientId: string, invoiceId: string) {
  await authorizePatient(actor, patientId, 'profile.read');
  const invoice = await Invoice.findOne({ _id: invoiceId, patientId, status: 'ISSUED' });
  if (!invoice) throw ApiError.notFound();
  return invoiceDetail(invoice);
}

function presentPayment(row: PaymentDocument) {
  return {
    id: String(row._id),
    method: row.method,
    status: row.status,
    amountMinor: row.amountMinor,
    currency: row.currency,
    receiptNumber: row.receiptNumber,
    providerPaymentId: row.providerPaymentId,
    patientRegistrationId: row.patientRegistrationId
      ? String(row.patientRegistrationId)
      : undefined,
    capturedAt: row.capturedAt,
    allocatedMinor: row.allocatedMinor,
    refundedMinor: row.refundedMinor,
    refundReservedMinor: row.refundReservedMinor,
    unappliedMinor: unapplied(row),
    version: row.version,
  };
}

export async function listPayments(
  actor: CommandActor,
  organizationId: string,
  query: z.infer<typeof paymentQuery>,
) {
  await authorizeOrganization(actor, organizationId, 'billing.read');
  const rows = await Payment.find({
    organizationId,
    ...(query.patientRegistrationId ? { patientRegistrationId: query.patientRegistrationId } : {}),
    ...before(query.before),
  })
    .sort({ _id: -1 })
    .limit(query.limit + 1);
  return pageOf(rows, query.limit, (row) => presentPayment(row));
}

export async function getPayment(actor: CommandActor, organizationId: string, paymentId: string) {
  await authorizeOrganization(actor, organizationId, 'billing.read');
  const payment = await Payment.findOne({ _id: paymentId, organizationId });
  if (!payment) throw ApiError.notFound();
  const refunds = await Refund.find({ paymentId }).sort({ _id: 1 }).lean();
  return {
    ...presentPayment(payment),
    refunds: refunds.map((refund) => ({
      id: String(refund._id),
      amountMinor: refund.amountMinor,
      status: refund.status,
      reason: refund.reason,
      completedAt: refund.completedAt,
      failureCode: refund.failureCode,
    })),
  };
}

/** Records a deduplicated charge from a clinical or pharmacy source inside the caller's transaction. */
export async function recordCharge(
  actor: OperationActor,
  charge: {
    organizationId: string;
    patientId: string;
    patientRegistrationId: string;
    facilityId?: string;
    source: { type: string; id: string };
    sourceLineKey: string;
    description: string;
    serviceCode?: string;
    quantity: number;
    unitPriceMinor: number;
    taxBasisPoints: number;
  },
  session: ClientSession,
) {
  const existing = await ChargeItem.findOne({
    organizationId: charge.organizationId,
    'source.type': charge.source.type,
    'source.id': charge.source.id,
    sourceLineKey: charge.sourceLineKey,
  }).session(session);
  if (existing) return existing;
  const who = actorRef(actor);
  const [row] = await ChargeItem.create([{ ...charge, createdBy: who, updatedBy: who }], {
    session,
  });
  return row!;
}

export async function listCharges(
  actor: CommandActor,
  organizationId: string,
  query: z.infer<typeof chargeQuery>,
) {
  await authorizeOrganization(actor, organizationId, 'billing.read');
  const rows = await ChargeItem.find({
    organizationId,
    patientRegistrationId: query.patientRegistrationId,
    status: query.status,
    ...before(query.before),
  })
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean();
  return pageOf(rows, query.limit, (row) => ({
    id: String(row._id),
    description: row.description,
    serviceCode: row.serviceCode,
    quantity: row.quantity,
    unitPriceMinor: row.unitPriceMinor,
    taxBasisPoints: row.taxBasisPoints,
    status: row.status,
    source: row.source,
    createdAt: row.createdAt,
  }));
}
