import { Schema, model } from 'mongoose';
import {
  actorSchema,
  aggregateOptions,
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

export const DOCUMENT_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'] as const;
export type DocumentMimeType = (typeof DOCUMENT_TYPES)[number];

const custodySchema = new Schema(
  {
    kind: { type: String, enum: ['PATIENT', 'ORGANIZATION', 'USER'], required: true },
    patientId: ref('Patient', false),
    organizationId: ref('Organization', false),
    userId: ref('User', false),
  },
  value,
);
custodySchema.pre('validate', function () {
  const holders = [this.patientId, this.organizationId, this.userId].filter(Boolean).length;
  const expected = {
    PATIENT: this.patientId,
    ORGANIZATION: this.organizationId,
    USER: this.userId,
  }[this.kind];
  if (holders !== 1 || !expected)
    throw new Error('A document has exactly one custodian of its declared kind');
});

const documentSchema = new Schema(
  {
    ...metadataFields,
    custody: { type: custodySchema, required: true },
    subjectPatientId: ref('Patient', false),
    patientRegistrationId: ref('PatientRegistration', false),
    category: {
      type: String,
      enum: ['CLINICAL_REPORT', 'PRESCRIPTION', 'CREDENTIAL', 'IDENTITY', 'CONSENT', 'OTHER'],
      required: true,
    },
    classification: { type: String, enum: ['PERSONAL', 'CLINICAL', 'RESTRICTED'], required: true },
    title: { type: String, required: true, maxlength: 200 },
    uploadedBy: ref('User'),
    status: {
      type: String,
      enum: ['PENDING_UPLOAD', 'QUARANTINED', 'SCANNING', 'AVAILABLE', 'REJECTED', 'ARCHIVED'],
      default: 'PENDING_UPLOAD',
    },
    pendingUpload: {
      type: new Schema(
        {
          key: { type: String, required: true },
          expectedMimeType: { type: String, enum: DOCUMENT_TYPES, required: true },
          sizeBytes: { type: Number, required: true, min: 1 },
          originalName: { type: String, required: true, maxlength: 200 },
        },
        value,
      ),
    },
    uploadExpiresAt: Date,
    currentVersionId: ref('DocumentVersion', false),
    versionCount: { type: Number, default: 0 },
    rejectionReason: { type: String, maxlength: 200 },
    scanAttempts: { type: Number, default: 0 },
    nextScanAt: Date,
    scanLeaseUntil: Date,
    releasedToPatientAt: Date,
    retentionClass: { type: String, default: 'CLINICAL_STANDARD', maxlength: 60 },
  },
  aggregateOptions,
);
documentSchema.index({ 'custody.organizationId': 1, subjectPatientId: 1, _id: -1 });
documentSchema.index({ 'custody.patientId': 1, _id: -1 });
documentSchema.index({ 'custody.userId': 1, _id: -1 });
documentSchema.index({ subjectPatientId: 1, releasedToPatientAt: 1 });
documentSchema.index({ status: 1, nextScanAt: 1 });
documentSchema.index({ status: 1, uploadExpiresAt: 1 });
export const ClinicalDocument = model('ClinicalDocument', documentSchema, 'documents');

const versionSchema = new Schema(
  {
    documentId: ref('ClinicalDocument'),
    versionNumber: { type: Number, required: true, min: 1 },
    file: {
      type: new Schema(
        {
          provider: { type: String, required: true },
          bucket: { type: String, required: true },
          key: { type: String, required: true },
          objectVersion: String,
          sha256: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
          sizeBytes: { type: Number, required: true, min: 1 },
          mimeType: { type: String, enum: DOCUMENT_TYPES, required: true },
        },
        value,
      ),
      required: true,
    },
    originalName: { type: String, required: true, maxlength: 200 },
    scan: {
      type: new Schema(
        {
          status: { type: String, enum: ['CLEAN'], required: true },
          engine: { type: String, required: true },
          version: { type: String, required: true },
          scannedAt: { type: Date, required: true },
        },
        value,
      ),
      required: true,
    },
    availableAt: { type: Date, required: true },
    createdBy: { type: actorSchema, required: true },
    schemaVersion: { type: Number, default: 1 },
  },
  appendOnly,
);
versionSchema.index({ documentId: 1, versionNumber: 1 }, { unique: true });
versionSchema.index({ 'file.bucket': 1, 'file.key': 1 }, { unique: true });
versionSchema.pre('save', function () {
  if (!this.isNew) throw new Error('Document versions are immutable');
});
versionSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany'],
  () => {
    throw new Error('Document versions are immutable');
  },
);
export const DocumentVersion = model('DocumentVersion', versionSchema, 'documentVersions');

export const LINK_TARGETS = [
  'doctorVerificationCase',
  'encounter',
  'diagnosticReport',
  'admission',
] as const;
const linkSchema = new Schema(
  {
    documentId: ref('ClinicalDocument'),
    target: {
      type: new Schema(
        {
          type: { type: String, enum: LINK_TARGETS, required: true },
          id: { type: Schema.Types.ObjectId, required: true },
        },
        value,
      ),
      required: true,
    },
    organizationId: ref('Organization', false),
    relationship: { type: String, enum: ['EVIDENCE', 'REPORT', 'ATTACHMENT'], required: true },
    createdBy: { type: actorSchema, required: true },
    createdAt: { type: Date, default: Date.now },
    schemaVersion: { type: Number, default: 1 },
  },
  appendOnly,
);
linkSchema.index(
  { documentId: 1, 'target.type': 1, 'target.id': 1, relationship: 1 },
  { unique: true },
);
linkSchema.index({ 'target.type': 1, 'target.id': 1 });
export const DocumentLink = model('DocumentLink', linkSchema, 'documentLinks');
