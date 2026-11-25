import { Schema, model } from 'mongoose';
import { aggregateOptions, metadataFields, ref } from '../../shared/persistence/schema.js';

const minor = { type: Number, required: true, min: 0 } as const;

/** Platform catalog of insurers, TPAs, government schemes and corporate payers. */
const payerSchema = new Schema(
  {
    ...metadataFields,
    code: { type: String, required: true, maxlength: 40 },
    name: { type: String, required: true, maxlength: 200 },
    kind: {
      type: String,
      enum: ['INSURER', 'TPA', 'GOVERNMENT_SCHEME', 'CORPORATE'],
      required: true,
    },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
  },
  aggregateOptions,
);
payerSchema.index({ code: 1 }, { unique: true });
export const Payer = model('Payer', payerSchema, 'payers');

/** A patient's policy. Patients add their own; billing staff may record one at registration. */
const coverageSchema = new Schema(
  {
    ...metadataFields,
    patientId: ref('Patient'),
    payerId: ref('Payer'),
    memberId: { type: String, required: true, maxlength: 60 },
    policyNumber: { type: String, required: true, maxlength: 60 },
    planName: { type: String, maxlength: 200 },
    holderName: { type: String, required: true, maxlength: 200 },
    relationshipToHolder: {
      type: String,
      enum: ['SELF', 'SPOUSE', 'CHILD', 'PARENT', 'OTHER'],
      required: true,
    },
    validFrom: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    validUntil: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    source: { type: String, enum: ['PATIENT', 'PROVIDER'], required: true },
    status: { type: String, enum: ['ACTIVE', 'ENDED'], default: 'ACTIVE' },
  },
  aggregateOptions,
);
coverageSchema.index({ patientId: 1, status: 1 });
coverageSchema.index(
  { payerId: 1, policyNumber: 1, memberId: 1 },
  { unique: true, partialFilterExpression: { status: 'ACTIVE' } },
);
export const InsuranceCoverage = model('InsuranceCoverage', coverageSchema, 'insuranceCoverages');

/** Cashless pre-authorization request for planned care (often an admission). */
const preauthSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    facilityId: ref('Facility'),
    patientId: ref('Patient'),
    patientRegistrationId: ref('PatientRegistration'),
    coverageId: ref('InsuranceCoverage'),
    payerId: ref('Payer'),
    admissionId: ref('Admission', false),
    number: { type: String, required: true, maxlength: 40 },
    treatmentSummary: { type: String, required: true, maxlength: 2000 },
    requestedMinor: minor,
    approvedMinor: { type: Number, min: 0 },
    payerReference: { type: String, maxlength: 100 },
    decisionReason: { type: String, maxlength: 1000 },
    validUntil: Date,
    status: {
      type: String,
      enum: ['SUBMITTED', 'APPROVED', 'PARTIALLY_APPROVED', 'DENIED', 'CANCELLED'],
      default: 'SUBMITTED',
    },
  },
  aggregateOptions,
);
preauthSchema.index({ organizationId: 1, number: 1 }, { unique: true });
preauthSchema.index({ organizationId: 1, status: 1 });
export const Preauthorization = model('Preauthorization', preauthSchema, 'preauthorizations');

/**
 * Claim for issued invoices. Invariants: approved ≤ claimed ≤ outstanding at submission;
 * settled ≤ approved; an invoice is on at most one open claim (ClaimInvoice unique index).
 */
const claimSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    facilityId: ref('Facility'),
    patientId: ref('Patient'),
    patientRegistrationId: ref('PatientRegistration'),
    coverageId: ref('InsuranceCoverage'),
    payerId: ref('Payer'),
    preauthorizationId: ref('Preauthorization', false),
    number: { type: String, required: true, maxlength: 40 },
    invoiceIds: { type: [Schema.Types.ObjectId], required: true },
    claimedMinor: minor,
    approvedMinor: { type: Number, min: 0 },
    disallowedMinor: { type: Number, min: 0 },
    settledMinor: { type: Number, min: 0, default: 0 },
    paymentId: ref('Payment', false),
    payerReference: { type: String, maxlength: 100 },
    decisionReason: { type: String, maxlength: 1000 },
    status: {
      type: String,
      enum: ['SUBMITTED', 'APPROVED', 'PARTIALLY_APPROVED', 'DENIED', 'SETTLED', 'WITHDRAWN'],
      default: 'SUBMITTED',
    },
    submittedAt: { type: Date, required: true },
    adjudicatedAt: Date,
    settledAt: Date,
  },
  aggregateOptions,
);
claimSchema.index({ organizationId: 1, number: 1 }, { unique: true });
claimSchema.index({ organizationId: 1, status: 1, _id: -1 });
export const InsuranceClaim = model('InsuranceClaim', claimSchema, 'insuranceClaims');

const claimInvoiceSchema = new Schema(
  {
    organizationId: ref('Organization'),
    claimId: ref('InsuranceClaim'),
    invoiceId: ref('Invoice'),
    open: { type: Boolean, default: true },
  },
  { timestamps: true, strict: 'throw', versionKey: false, autoIndex: false, autoCreate: false },
);
claimInvoiceSchema.index(
  { invoiceId: 1 },
  { unique: true, partialFilterExpression: { open: true } },
);
export const ClaimInvoice = model('ClaimInvoice', claimInvoiceSchema, 'claimInvoices');
