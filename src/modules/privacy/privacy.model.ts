import { Schema, model } from 'mongoose';
import {
  actorSchema,
  aggregateOptions,
  bounded,
  metadataFields,
  ref,
} from '../../shared/persistence/schema.js';

const value = { _id: false, strict: 'throw', versionKey: false } as const;
const appendOnly = {
  strict: 'throw',
  versionKey: false,
  autoIndex: false,
  autoCreate: false,
} as const;

/** Clinical resource families a grant may cover. Grants never name arbitrary collections. */
export const SHAREABLE_RESOURCES = [
  'encounters',
  'clinicalNotes',
  'diagnoses',
  'observations',
  'allergies',
  'conditions',
  'medicationStatements',
  'prescriptions',
  'diagnosticReports',
  'immunizations',
  'documents',
] as const;
export type ShareableResource = (typeof SHAREABLE_RESOURCES)[number];

const policyVersionSchema = new Schema(
  {
    kind: {
      type: String,
      enum: ['PRIVACY', 'TERMS', 'SHARING', 'TELEMEDICINE', 'RECORD_SHARING_CONSENT'],
      required: true,
    },
    code: { type: String, required: true, maxlength: 60 },
    versionNumber: { type: Number, required: true, min: 1 },
    language: { type: String, required: true, maxlength: 10 },
    title: { type: String, required: true, maxlength: 200 },
    text: { type: String, required: true, maxlength: 50_000 },
    contentHash: { type: String, required: true },
    effectiveFrom: { type: Date, required: true },
    approvedBy: { type: actorSchema, required: true },
    createdAt: { type: Date, default: Date.now },
    schemaVersion: { type: Number, default: 1 },
  },
  appendOnly,
);
policyVersionSchema.index({ code: 1, versionNumber: 1, language: 1 }, { unique: true });
policyVersionSchema.index({ kind: 1, language: 1, effectiveFrom: -1 });
policyVersionSchema.pre('save', function () {
  if (!this.isNew) throw new Error('Published policy versions are immutable');
});
export const PolicyVersion = model('PolicyVersion', policyVersionSchema, 'policyVersions');

const acknowledgementSchema = new Schema(
  {
    userId: ref('User'),
    patientId: ref('Patient', false),
    policyVersionId: ref('PolicyVersion'),
    acceptedAt: { type: Date, required: true },
    channel: { type: String, enum: ['WEB', 'MOBILE', 'ASSISTED'], required: true },
    evidenceHash: { type: String, required: true },
    schemaVersion: { type: Number, default: 1 },
  },
  appendOnly,
);
acknowledgementSchema.index({ userId: 1, policyVersionId: 1 }, { unique: true });
export const PolicyAcknowledgement = model(
  'PolicyAcknowledgement',
  acknowledgementSchema,
  'policyAcknowledgements',
);

const consentSchema = new Schema(
  {
    ...metadataFields,
    patientId: ref('Patient'),
    kind: { type: String, enum: ['RECORD_SHARING', 'TELEMEDICINE', 'PROCEDURE'], required: true },
    /** Organization that recorded a provider-side consent (telemedicine/procedure). */
    organizationId: ref('Organization', false),
    policyVersionId: ref('PolicyVersion', false),
    grantorUserId: ref('User'),
    grantorRelationship: {
      type: String,
      enum: ['SELF', 'REPRESENTATIVE', 'RECORDED_BY_PROVIDER'],
      required: true,
    },
    recipientOrganizationId: ref('Organization', false),
    purposes: {
      type: [{ type: String, enum: ['TREATMENT', 'SECOND_OPINION', 'CARE_COORDINATION'] }],
      default: [],
      validate: bounded(5),
    },
    resourceTypes: {
      type: [{ type: String, enum: SHAREABLE_RESOURCES }],
      default: [],
      validate: bounded(20),
    },
    recordPeriodStart: Date,
    recordPeriodEnd: Date,
    procedureDescription: { type: String, maxlength: 2000 },
    validFrom: { type: Date, required: true },
    expiresAt: Date,
    status: { type: String, enum: ['ACTIVE', 'WITHDRAWN', 'EXPIRED'], default: 'ACTIVE' },
    withdrawnAt: Date,
    evidenceHash: { type: String, required: true },
    authorizationFence: { type: Number, default: 0 },
  },
  aggregateOptions,
);
consentSchema.index({ patientId: 1, status: 1, expiresAt: 1 });
consentSchema.index({ recipientOrganizationId: 1, status: 1 });
export const Consent = model('Consent', consentSchema, 'consents');

const consentEventSchema = new Schema(
  {
    consentId: ref('Consent'),
    patientId: ref('Patient'),
    sequence: { type: Number, required: true, min: 0 },
    type: { type: String, enum: ['GRANTED', 'WITHDRAWN', 'EXPIRED'], required: true },
    reason: { type: String, maxlength: 1000 },
    evidenceHash: { type: String, required: true },
    effectiveAt: { type: Date, required: true },
    actor: { type: actorSchema, required: true },
    schemaVersion: { type: Number, default: 1 },
  },
  appendOnly,
);
consentEventSchema.index({ consentId: 1, sequence: 1 }, { unique: true });
consentEventSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany'],
  () => {
    throw new Error('Consent events are append-only');
  },
);
export const ConsentEvent = model('ConsentEvent', consentEventSchema, 'consentEvents');

const grantSchema = new Schema(
  {
    ...metadataFields,
    patientId: ref('Patient'),
    recipient: {
      type: new Schema(
        {
          kind: { type: String, enum: ['ORGANIZATION', 'USER'], required: true },
          id: { type: Schema.Types.ObjectId, required: true },
        },
        value,
      ),
      required: true,
    },
    /** Organization under whose policy an emergency grant was issued. */
    organizationId: ref('Organization', false),
    consentId: ref('Consent', false),
    basis: { type: String, enum: ['CONSENT', 'EMERGENCY'], required: true },
    purpose: { type: String, required: true, maxlength: 200 },
    resourceTypes: {
      type: [{ type: String, enum: SHAREABLE_RESOURCES }],
      default: [],
      validate: bounded(20),
    },
    recordPeriodStart: Date,
    recordPeriodEnd: Date,
    validFrom: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: Date,
    reason: { type: String, maxlength: 1000 },
    breakGlassReviewDueAt: Date,
    reviewedAt: Date,
    reviewedBy: ref('User', false),
    reviewOutcome: { type: String, enum: ['JUSTIFIED', 'UNJUSTIFIED'] },
    reviewNote: { type: String, maxlength: 1000 },
  },
  aggregateOptions,
);
grantSchema.index({ patientId: 1, 'recipient.kind': 1, 'recipient.id': 1, expiresAt: 1 });
grantSchema.index({ consentId: 1 });
grantSchema.index({ organizationId: 1, basis: 1, reviewedAt: 1 });
export const AccessGrant = model('AccessGrant', grantSchema, 'accessGrants');

const privacyRequestSchema = new Schema(
  {
    ...metadataFields,
    patientId: ref('Patient'),
    requesterId: ref('User'),
    kind: {
      type: String,
      enum: ['ACCESS', 'EXPORT', 'CORRECTION', 'ERASURE', 'GRIEVANCE'],
      required: true,
    },
    organizationId: ref('Organization', false),
    status: {
      type: String,
      enum: ['OPEN', 'VERIFYING', 'IN_PROGRESS', 'COMPLETED', 'PARTIALLY_COMPLETED', 'REJECTED'],
      default: 'OPEN',
    },
    dueAt: { type: Date, required: true },
    reason: { type: String, required: true, maxlength: 4000 },
    decisionReason: { type: String, maxlength: 4000 },
    assigneeId: ref('User', false),
    completedAt: Date,
  },
  aggregateOptions,
);
privacyRequestSchema.index({ status: 1, dueAt: 1 });
privacyRequestSchema.index({ patientId: 1, createdAt: -1 });
export const PrivacyRequest = model('PrivacyRequest', privacyRequestSchema, 'privacyRequests');

const retentionHoldSchema = new Schema(
  {
    ...metadataFields,
    scope: {
      type: new Schema(
        {
          kind: { type: String, enum: ['ORGANIZATION', 'PATIENT'], required: true },
          organizationId: ref('Organization', false),
          patientId: ref('Patient', false),
        },
        value,
      ),
      required: true,
    },
    reason: { type: String, required: true, maxlength: 1000 },
    startsAt: { type: Date, required: true },
    releasedAt: Date,
    approvedBy: ref('User'),
  },
  aggregateOptions,
);
retentionHoldSchema.index({ 'scope.patientId': 1, releasedAt: 1 });
retentionHoldSchema.index({ 'scope.organizationId': 1, releasedAt: 1 });
export const RetentionHold = model('RetentionHold', retentionHoldSchema, 'retentionHolds');
