import { Schema, model } from 'mongoose';
import {
  metadataFields,
  aggregateOptions,
  nameSchema,
  addressSchema,
  contactSchema,
  bounded,
  ref,
} from '../../shared/persistence/schema.js';

export const demographicFields = {
  name: { type: nameSchema, required: true },
  birthDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
  administrativeSex: { type: String, enum: ['FEMALE', 'MALE', 'OTHER', 'UNKNOWN'], required: true },
  preferredLanguage: { type: String, required: true },
  addresses: { type: [addressSchema], default: [], validate: bounded(10) },
  contacts: { type: [contactSchema], default: [], validate: bounded(10) },
  emergencyContacts: {
    type: [
      new Schema(
        {
          name: { type: nameSchema, required: true },
          relation: { type: String, required: true },
          phone: { type: String, required: true },
        },
        { _id: false, strict: 'throw', versionKey: false },
      ),
    ],
    default: [],
    validate: bounded(5),
  },
} as const;
const patientSchema = new Schema(
  {
    ...metadataFields,
    ...demographicFields,
    ownerUserId: ref('User', false),
    birthDatePrecision: { type: String, enum: ['EXACT', 'UNKNOWN'], required: true },
    status: {
      type: String,
      enum: ['ACTIVE', 'TEMPORARY', 'MERGED', 'DECEASED'],
      default: 'ACTIVE',
    },
    /** Set on a duplicate after a reviewed merge; the survivor lists its merged aliases. */
    mergedIntoId: ref('Patient', false),
    mergedPatientIds: { type: [Schema.Types.ObjectId], default: [], validate: bounded(20) },
    authorizationFence: { type: Number, default: 0 },
  },
  aggregateOptions,
);
patientSchema.index(
  { ownerUserId: 1 },
  { unique: true, partialFilterExpression: { ownerUserId: { $type: 'objectId' } } },
);
export const Patient = model('Patient', patientSchema, 'patients');

const relationshipSchema = new Schema(
  {
    ...metadataFields,
    patientId: ref('Patient'),
    relatedUserId: ref('User'),
    relationship: {
      type: String,
      enum: ['PARENT', 'GUARDIAN', 'CAREGIVER', 'REPRESENTATIVE'],
      required: true,
    },
    allowedActions: {
      type: [
        {
          type: String,
          enum: [
            'profile.read',
            'profile.update',
            'registration.create',
            'medical.read',
            'medical.upload',
            'medical.export',
            'consent.manage',
          ],
        },
      ],
      required: true,
    },
    authorityReference: { type: String, required: true, maxlength: 500 },
    medicalAuthorityReference: { type: String, maxlength: 500 },
    status: {
      type: String,
      enum: ['PENDING', 'ACTIVE', 'REJECTED', 'REVOKED', 'EXPIRED'],
      default: 'PENDING',
    },
    validFrom: Date,
    validUntil: Date,
    verifiedBy: ref('User', false),
    verifiedAt: Date,
    decisionReason: String,
    authorizationFence: { type: Number, default: 0 },
  },
  aggregateOptions,
);
relationshipSchema.index({ patientId: 1, relatedUserId: 1 }, { unique: true });
relationshipSchema.index({ relatedUserId: 1, status: 1 });
relationshipSchema.index({ status: 1, createdAt: 1 });
export const PatientRelationship = model(
  'PatientRelationship',
  relationshipSchema,
  'patientRelationships',
);

const registrationSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    patientId: ref('Patient'),
    mrn: { type: String, required: true },
    primaryFacilityId: ref('Facility'),
    demographicSnapshot: {
      type: new Schema(demographicFields, { _id: false, strict: 'throw', versionKey: false }),
      required: true,
    },
    registeredAt: { type: Date, default: Date.now, required: true },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE', 'MERGED'], default: 'ACTIVE' },
  },
  aggregateOptions,
);
registrationSchema.index({ organizationId: 1, mrn: 1 }, { unique: true });
registrationSchema.index({ organizationId: 1, patientId: 1 }, { unique: true });
registrationSchema.index({ organizationId: 1, primaryFacilityId: 1, _id: -1 });
export const PatientRegistration = model(
  'PatientRegistration',
  registrationSchema,
  'patientRegistrations',
);

/**
 * Reviewed duplicate-identity merge. The duplicate (typically a provider-created record the
 * patient never claimed) becomes an alias of the surviving identity; nothing is deleted and every
 * custodian's records keep their original references.
 */
const mergeCaseSchema = new Schema(
  {
    ...metadataFields,
    sourcePatientId: ref('Patient'),
    targetPatientId: ref('Patient'),
    requestedBy: ref('User'),
    requestedVia: { type: String, enum: ['PATIENT', 'PROVIDER'], required: true },
    organizationId: ref('Organization', false),
    evidence: { type: String, required: true, maxlength: 2000 },
    status: {
      type: String,
      enum: ['SUBMITTED', 'APPROVED', 'REJECTED', 'WITHDRAWN'],
      default: 'SUBMITTED',
    },
    reviewedBy: ref('User', false),
    decidedAt: Date,
    reason: { type: String, maxlength: 1000 },
  },
  aggregateOptions,
);
mergeCaseSchema.index(
  { sourcePatientId: 1 },
  { unique: true, partialFilterExpression: { status: 'SUBMITTED' } },
);
mergeCaseSchema.index({ status: 1, _id: -1 });
export const PatientMergeCase = model('PatientMergeCase', mergeCaseSchema, 'patientMergeCases');
