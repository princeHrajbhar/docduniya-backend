import { Schema, model } from 'mongoose';
import {
  actorSchema,
  addressSchema,
  aggregateOptions,
  bounded,
  metadataFields,
  ref,
} from '../../shared/persistence/schema.js';

const value = { _id: false, strict: 'throw', versionKey: false } as const;
const minor = { type: Number, required: true, min: 0, validate: Number.isSafeInteger };
const currency = { type: String, enum: ['INR'], default: 'INR' };
const appendOnly = {
  strict: 'throw',
  versionKey: false,
  autoIndex: false,
  autoCreate: false,
} as const;
function sealed(schema: Schema, label: string) {
  schema.pre('save', function () {
    if (!this.isNew) throw new Error(`${label} records are append-only`);
  });
  schema.pre(
    [
      'updateOne',
      'updateMany',
      'findOneAndUpdate',
      'replaceOne',
      'findOneAndReplace',
      'deleteOne',
      'deleteMany',
      'findOneAndDelete',
    ],
    () => {
      throw new Error(`${label} records are append-only`);
    },
  );
}
const resourceRef = new Schema(
  { type: { type: String, required: true, maxlength: 60 }, id: { type: String, required: true } },
  value,
);

// ── Merchant configuration ───────────────────────────────────────────────────
const merchantSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    provider: { type: String, enum: ['RAZORPAY'], required: true },
    label: { type: String, required: true, maxlength: 200 },
    /** Razorpay key id. Secrets are vault/environment references, never stored values. */
    providerAccountId: { type: String, required: true, maxlength: 100 },
    keySecretRef: { type: String, required: true, maxlength: 120 },
    webhookSecretRef: { type: String, required: true, maxlength: 120 },
    mode: { type: String, enum: ['DIRECT'], default: 'DIRECT' },
    status: {
      type: String,
      enum: ['PENDING', 'ACTIVE', 'RESTRICTED', 'CLOSED'],
      default: 'PENDING',
    },
    verifiedAt: Date,
    verifiedBy: ref('User', false),
    statusReason: { type: String, maxlength: 1000 },
    authorizationFence: { type: Number, default: 0 },
  },
  aggregateOptions,
);
merchantSchema.index({ provider: 1, providerAccountId: 1 }, { unique: true });
merchantSchema.index(
  { organizationId: 1 },
  { unique: true, partialFilterExpression: { status: 'ACTIVE' } },
);
merchantSchema.index({ status: 1, createdAt: 1 });
export const MerchantAccount = model('MerchantAccount', merchantSchema, 'merchantAccounts');

// ── Charges and invoices ─────────────────────────────────────────────────────
const chargeSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    patientId: ref('Patient'),
    patientRegistrationId: ref('PatientRegistration'),
    facilityId: ref('Facility', false),
    source: { type: resourceRef, required: true },
    sourceLineKey: { type: String, required: true, maxlength: 100 },
    description: { type: String, required: true, maxlength: 200 },
    serviceCode: { type: String, maxlength: 60 },
    quantity: {
      type: Number,
      required: true,
      min: 1,
      max: 100_000,
      validate: Number.isSafeInteger,
    },
    unitPriceMinor: minor,
    taxBasisPoints: { type: Number, default: 0, min: 0, max: 10_000 },
    status: { type: String, enum: ['UNBILLED', 'BILLED', 'REVERSED'], default: 'UNBILLED' },
    invoiceId: ref('Invoice', false),
  },
  aggregateOptions,
);
chargeSchema.index(
  { organizationId: 1, 'source.type': 1, 'source.id': 1, sourceLineKey: 1 },
  { unique: true },
);
chargeSchema.index({ organizationId: 1, patientRegistrationId: 1, status: 1 });
export const ChargeItem = model('ChargeItem', chargeSchema, 'chargeItems');

const invoiceSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    kind: { type: String, enum: ['PATIENT_CARE', 'SUBSCRIPTION'], default: 'PATIENT_CARE' },
    number: { type: String, maxlength: 40 },
    fiscalPeriod: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
    seller: {
      type: new Schema(
        {
          organizationId: ref('Organization'),
          name: { type: String, required: true },
          address: { type: addressSchema, required: true },
        },
        value,
      ),
      required: true,
    },
    buyer: {
      type: new Schema(
        {
          kind: { type: String, enum: ['PATIENT', 'ORGANIZATION'], required: true },
          id: { type: Schema.Types.ObjectId, required: true },
          name: { type: String, required: true, maxlength: 200 },
        },
        value,
      ),
      required: true,
    },
    patientId: ref('Patient', false),
    patientRegistrationId: ref('PatientRegistration', false),
    facilityId: ref('Facility', false),
    appointmentId: ref('Appointment', false),
    /** Present while the invoice is not void; enforces one live invoice per appointment. */
    appointmentKey: { type: String },
    subscriptionId: ref('Subscription', false),
    status: { type: String, enum: ['DRAFT', 'ISSUED', 'VOID'], default: 'DRAFT' },
    issuedAt: Date,
    dueAt: Date,
    currency,
    lineCount: { type: Number, default: 0, min: 0, max: 500 },
    subtotalMinor: { ...minor, default: 0 },
    discountMinor: { ...minor, default: 0 },
    taxMinor: { ...minor, default: 0 },
    totalMinor: { ...minor, default: 0 },
    allocatedMinor: { ...minor, default: 0 },
    creditedMinor: { ...minor, default: 0 },
    journalId: ref('LedgerJournal', false),
  },
  aggregateOptions,
);
invoiceSchema.index(
  { organizationId: 1, fiscalPeriod: 1, number: 1 },
  { unique: true, partialFilterExpression: { number: { $type: 'string' } } },
);
invoiceSchema.index(
  { organizationId: 1, appointmentKey: 1 },
  { unique: true, partialFilterExpression: { appointmentKey: { $type: 'string' } } },
);
invoiceSchema.index({ organizationId: 1, 'buyer.id': 1, issuedAt: -1 });
invoiceSchema.index({ organizationId: 1, status: 1, _id: -1 });
invoiceSchema.pre('validate', function () {
  if (this.creditedMinor + this.allocatedMinor > this.totalMinor)
    throw new Error('Invoice credits and allocations cannot exceed its total');
});
export const Invoice = model('Invoice', invoiceSchema, 'invoices');

const invoiceItemSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    invoiceId: ref('Invoice'),
    lineNumber: { type: Number, required: true, min: 1, max: 500 },
    chargeItemId: ref('ChargeItem', false),
    description: { type: String, required: true, maxlength: 200 },
    serviceCode: { type: String, maxlength: 60 },
    quantity: {
      type: Number,
      required: true,
      min: 1,
      max: 100_000,
      validate: Number.isSafeInteger,
    },
    unitPriceMinor: minor,
    discountMinor: { ...minor, default: 0 },
    taxBasisPoints: { type: Number, default: 0, min: 0, max: 10_000 },
    netMinor: minor,
    taxMinor: minor,
    totalMinor: minor,
    creditedMinor: { ...minor, default: 0 },
  },
  aggregateOptions,
);
invoiceItemSchema.index({ organizationId: 1, invoiceId: 1, lineNumber: 1 }, { unique: true });
invoiceItemSchema.index(
  { organizationId: 1, chargeItemId: 1 },
  { unique: true, partialFilterExpression: { chargeItemId: { $type: 'objectId' } } },
);
export const InvoiceItem = model('InvoiceItem', invoiceItemSchema, 'invoiceItems');

const creditNoteSchema = new Schema(
  {
    organizationId: ref('Organization'),
    invoiceId: ref('Invoice'),
    number: { type: String, required: true },
    reason: { type: String, required: true, maxlength: 1000 },
    lines: {
      type: [
        new Schema(
          {
            invoiceLineNumber: { type: Number, required: true },
            netMinor: minor,
            taxMinor: minor,
            totalMinor: minor,
          },
          value,
        ),
      ],
      validate: bounded(500),
    },
    totalMinor: minor,
    currency,
    status: { type: String, enum: ['ISSUED'], default: 'ISSUED' },
    issuedAt: { type: Date, required: true },
    journalId: ref('LedgerJournal'),
    createdBy: { type: actorSchema, required: true },
    createdAt: { type: Date, default: Date.now },
    schemaVersion: { type: Number, default: 1 },
  },
  appendOnly,
);
creditNoteSchema.index({ organizationId: 1, number: 1 }, { unique: true });
creditNoteSchema.index({ organizationId: 1, invoiceId: 1 });
sealed(creditNoteSchema, 'Credit note');
export const CreditNote = model('CreditNote', creditNoteSchema, 'creditNotes');

// ── Payments ─────────────────────────────────────────────────────────────────
const intentSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    merchantAccountId: ref('MerchantAccount'),
    payerUserId: ref('User', false),
    patientId: ref('Patient', false),
    appointmentId: ref('Appointment', false),
    holdToken: { type: String, maxlength: 100 },
    invoiceIds: { type: [Schema.Types.ObjectId], default: [], validate: bounded(50) },
    amountMinor: minor,
    currency,
    providerOrderId: { type: String, maxlength: 100 },
    operationKey: { type: String, required: true, maxlength: 200 },
    status: {
      type: String,
      enum: ['CREATED', 'ORDER_PENDING', 'READY', 'SUCCEEDED', 'CANCELLED', 'RECONCILE'],
      default: 'CREATED',
    },
    outcome: { type: String, enum: ['CONFIRMED', 'INVOICE_PAID', 'REFUND_REQUIRED'] },
    orderAttempts: { type: Number, default: 0 },
    orderLeaseToken: String,
    orderLeaseUntil: Date,
    nextAttemptAt: Date,
    lastErrorCode: { type: String, maxlength: 100 },
    expiresAt: Date,
  },
  aggregateOptions,
);
intentSchema.index({ organizationId: 1, operationKey: 1 }, { unique: true });
intentSchema.index(
  { merchantAccountId: 1, providerOrderId: 1 },
  { unique: true, partialFilterExpression: { providerOrderId: { $type: 'string' } } },
);
intentSchema.index({ status: 1, nextAttemptAt: 1 });
export const PaymentIntent = model('PaymentIntent', intentSchema, 'paymentIntents');

const paymentSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    intentId: ref('PaymentIntent', false),
    merchantAccountId: ref('MerchantAccount', false),
    providerPaymentId: { type: String, maxlength: 100 },
    method: {
      type: String,
      enum: ['GATEWAY', 'CASH', 'BANK_TRANSFER', 'CHEQUE', 'UPI_OFFLINE', 'INSURANCE'],
      required: true,
    },
    status: { type: String, enum: ['CAPTURED', 'FAILED'], required: true },
    amountMinor: minor,
    currency,
    patientId: ref('Patient', false),
    patientRegistrationId: ref('PatientRegistration', false),
    payerName: { type: String, maxlength: 200 },
    capturedAt: Date,
    receivedBy: ref('User', false),
    offlineReference: { type: String, maxlength: 100 },
    receiptNumber: { type: String, maxlength: 40 },
    failureCode: { type: String, maxlength: 100 },
    allocatedMinor: { ...minor, default: 0 },
    refundedMinor: { ...minor, default: 0 },
    refundReservedMinor: { ...minor, default: 0 },
  },
  aggregateOptions,
);
paymentSchema.index(
  { merchantAccountId: 1, providerPaymentId: 1 },
  { unique: true, partialFilterExpression: { providerPaymentId: { $type: 'string' } } },
);
paymentSchema.index(
  { organizationId: 1, receiptNumber: 1 },
  { unique: true, partialFilterExpression: { receiptNumber: { $type: 'string' } } },
);
paymentSchema.index({ intentId: 1 });
paymentSchema.index({ organizationId: 1, _id: -1 });
paymentSchema.pre('validate', function () {
  // Direct-merchant invariant: captured >= netAllocated + refunded + refundReserved.
  if (this.allocatedMinor + this.refundedMinor + this.refundReservedMinor > this.amountMinor)
    throw new Error('Payment allocations and refunds exceed the captured amount');
});
export const Payment = model('Payment', paymentSchema, 'payments');

const allocationSchema = new Schema(
  {
    organizationId: ref('Organization'),
    paymentId: ref('Payment'),
    invoiceId: ref('Invoice'),
    amountMinor: { ...minor, min: 1 },
    currency,
    kind: { type: String, enum: ['APPLY', 'REVERSE'], required: true },
    reversesId: ref('PaymentAllocation', false),
    operationKey: { type: String, required: true, maxlength: 200 },
    journalId: ref('LedgerJournal'),
    createdBy: { type: actorSchema, required: true },
    createdAt: { type: Date, default: Date.now },
    schemaVersion: { type: Number, default: 1 },
  },
  appendOnly,
);
allocationSchema.index({ organizationId: 1, operationKey: 1 }, { unique: true });
allocationSchema.index({ paymentId: 1 });
allocationSchema.index({ invoiceId: 1 });
sealed(allocationSchema, 'Payment allocation');
export const PaymentAllocation = model('PaymentAllocation', allocationSchema, 'paymentAllocations');

const refundSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    paymentId: ref('Payment'),
    creditNoteId: ref('CreditNote', false),
    amountMinor: { ...minor, min: 1 },
    currency,
    reason: { type: String, required: true, maxlength: 1000 },
    requestedBy: { type: actorSchema, required: true },
    operationKey: { type: String, required: true, maxlength: 200 },
    providerRefundId: { type: String, maxlength: 100 },
    status: {
      type: String,
      enum: ['REQUESTED', 'PROCESSING', 'SUCCEEDED', 'FAILED'],
      default: 'REQUESTED',
    },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now },
    completedAt: Date,
    failureCode: { type: String, maxlength: 100 },
  },
  aggregateOptions,
);
refundSchema.index({ organizationId: 1, operationKey: 1 }, { unique: true });
refundSchema.index(
  { organizationId: 1, providerRefundId: 1 },
  { unique: true, partialFilterExpression: { providerRefundId: { $type: 'string' } } },
);
refundSchema.index({ paymentId: 1, status: 1 });
refundSchema.index({ status: 1, nextAttemptAt: 1 });
export const Refund = model('Refund', refundSchema, 'refunds');

const disputeSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    paymentId: ref('Payment'),
    providerDisputeId: { type: String, required: true, maxlength: 100 },
    amountMinor: minor,
    reasonCode: { type: String, maxlength: 100 },
    status: {
      type: String,
      enum: ['OPEN', 'EVIDENCE_SUBMITTED', 'WON', 'LOST', 'CLOSED'],
      default: 'OPEN',
    },
    dueAt: Date,
  },
  aggregateOptions,
);
disputeSchema.index({ organizationId: 1, providerDisputeId: 1 }, { unique: true });
disputeSchema.index({ status: 1, dueAt: 1 });
export const PaymentDispute = model('PaymentDispute', disputeSchema, 'paymentDisputes');

// ── Ledger ───────────────────────────────────────────────────────────────────
const accountSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    code: { type: String, required: true, maxlength: 40 },
    name: { type: String, required: true, maxlength: 200 },
    type: {
      type: String,
      enum: ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'],
      required: true,
    },
    currency,
    status: { type: String, enum: ['ACTIVE', 'CLOSED'], default: 'ACTIVE' },
  },
  aggregateOptions,
);
accountSchema.index({ organizationId: 1, code: 1, currency: 1 }, { unique: true });
export const LedgerAccount = model('LedgerAccount', accountSchema, 'ledgerAccounts');

const journalSchema = new Schema(
  {
    organizationId: ref('Organization'),
    number: { type: String, required: true },
    source: { type: resourceRef, required: true },
    operationKey: { type: String, required: true, maxlength: 200 },
    postedAt: { type: Date, required: true },
    currency,
    memo: { type: String, maxlength: 200 },
    entries: {
      type: [
        new Schema(
          {
            accountCode: { type: String, required: true },
            debitMinor: { ...minor, default: 0 },
            creditMinor: { ...minor, default: 0 },
          },
          value,
        ),
      ],
      validate: bounded(200),
    },
    reversesId: ref('LedgerJournal', false),
    createdBy: { type: actorSchema, required: true },
    schemaVersion: { type: Number, default: 1 },
  },
  appendOnly,
);
journalSchema.index({ organizationId: 1, operationKey: 1 }, { unique: true });
journalSchema.index({ organizationId: 1, number: 1 }, { unique: true });
journalSchema.index({ organizationId: 1, postedAt: 1 });
journalSchema.pre('validate', function () {
  const entries = this.entries;
  if (entries.length < 2) throw new Error('A journal needs at least two entries');
  let debit = 0;
  let credit = 0;
  for (const entry of entries) {
    if (entry.debitMinor > 0 === entry.creditMinor > 0)
      throw new Error('Each journal entry has exactly one positive side');
    debit += entry.debitMinor;
    credit += entry.creditMinor;
  }
  if (debit !== credit) throw new Error('Journal debits and credits must balance');
});
sealed(journalSchema, 'Ledger journal');
export const LedgerJournal = model('LedgerJournal', journalSchema, 'ledgerJournals');

// ── Gateway webhooks and reconciliation ──────────────────────────────────────
const inboxSchema = new Schema(
  {
    source: { type: String, required: true },
    sourceAccount: { type: String, required: true },
    externalEventId: { type: String, required: true, maxlength: 200 },
    eventType: { type: String, required: true, maxlength: 100 },
    receivedAt: { type: Date, default: Date.now },
    payloadHash: { type: String, required: true },
    /** Allowlisted identifiers only; card, contact and email fields are never stored. */
    extract: {
      type: new Schema(
        {
          paymentId: String,
          orderId: String,
          refundId: String,
          disputeId: String,
          amountMinor: Number,
          currency: String,
          status: String,
          reasonCode: String,
          dueBy: Number,
        },
        value,
      ),
      default: {},
    },
    verified: { type: Boolean, required: true },
    state: {
      type: String,
      enum: ['RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'IGNORED'],
      default: 'RECEIVED',
    },
    attempts: { type: Number, default: 0 },
    leaseUntil: Date,
    nextAttemptAt: { type: Date, default: Date.now },
    errorCode: { type: String, maxlength: 200 },
  },
  { timestamps: true, strict: 'throw', versionKey: false, autoIndex: false, autoCreate: false },
);
inboxSchema.index({ source: 1, sourceAccount: 1, externalEventId: 1 }, { unique: true });
inboxSchema.index({ state: 1, nextAttemptAt: 1 });
export const InboxEvent = model('InboxEvent', inboxSchema, 'inboxEvents');

const reconciliationRunSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    merchantAccountId: ref('MerchantAccount'),
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    status: { type: String, enum: ['RUNNING', 'COMPLETE', 'FAILED'], default: 'RUNNING' },
    matchedCount: { type: Number, default: 0 },
    exceptionCount: { type: Number, default: 0 },
    completedAt: Date,
    errorCode: String,
  },
  aggregateOptions,
);
reconciliationRunSchema.index({ organizationId: 1, merchantAccountId: 1, _id: -1 });
export const ReconciliationRun = model(
  'ReconciliationRun',
  reconciliationRunSchema,
  'reconciliationRuns',
);

const reconciliationItemSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    runId: ref('ReconciliationRun'),
    providerRowKey: { type: String, required: true },
    providerReference: { type: String, required: true },
    localPaymentId: ref('Payment', false),
    expectedMinor: { ...minor, default: 0 },
    actualMinor: { ...minor, default: 0 },
    status: {
      type: String,
      enum: ['MATCHED', 'MISSING_LOCAL', 'MISSING_PROVIDER', 'MISMATCH', 'RESOLVED'],
      required: true,
    },
    resolution: { type: String, maxlength: 1000 },
  },
  aggregateOptions,
);
reconciliationItemSchema.index(
  { organizationId: 1, runId: 1, providerRowKey: 1 },
  { unique: true },
);
reconciliationItemSchema.index({ organizationId: 1, status: 1 });
export const ReconciliationItem = model(
  'ReconciliationItem',
  reconciliationItemSchema,
  'reconciliationItems',
);
