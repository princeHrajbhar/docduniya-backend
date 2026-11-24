import { Schema, model } from 'mongoose';
import {
  addressSchema,
  contactSchema,
  metadataFields,
  aggregateOptions,
  ref,
  bounded,
} from '../../shared/persistence/schema.js';

const organizationSchema = new Schema(
  {
    ...metadataFields,
    kind: {
      type: String,
      enum: ['HOSPITAL', 'CLINIC', 'SOLO_PRACTICE', 'LAB', 'PHARMACY'],
      required: true,
    },
    legalName: { type: String, required: true, maxlength: 200 },
    displayName: { type: String, required: true, maxlength: 200 },
    slug: { type: String, required: true, match: /^[a-z0-9]+(?:-[a-z0-9]+)*$/ },
    legalAddress: { type: addressSchema, required: true },
    contacts: { type: [contactSchema], default: [], validate: bounded(10) },
    countryCode: { type: String, enum: ['IN'], default: 'IN' },
    status: {
      type: String,
      enum: ['DRAFT', 'UNDER_REVIEW', 'ACTIVE', 'SUSPENDED', 'OFFBOARDING', 'CLOSED'],
      default: 'DRAFT',
    },
    ownerUserId: ref('User'),
    authorizationFence: { type: Number, default: 0 },
  },
  aggregateOptions,
);
organizationSchema.index({ slug: 1 }, { unique: true });
organizationSchema.index({ status: 1, createdAt: -1 });
export const Organization = model('Organization', organizationSchema, 'organizations');

const facilitySchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    name: { type: String, required: true, maxlength: 200 },
    code: { type: String, required: true, maxlength: 40 },
    kind: {
      type: String,
      enum: ['HOSPITAL_BRANCH', 'CLINIC', 'VIRTUAL', 'LAB', 'PHARMACY'],
      required: true,
    },
    address: {
      type: addressSchema,
      required: function () {
        return this.kind !== 'VIRTUAL';
      },
    },
    timezone: { type: String, required: true, default: 'Asia/Kolkata' },
    publicContacts: { type: [contactSchema], default: [], validate: bounded(10) },
    status: { type: String, enum: ['DRAFT', 'ACTIVE', 'INACTIVE'], default: 'DRAFT' },
    authorizationFence: { type: Number, default: 0 },
  },
  aggregateOptions,
);
facilitySchema.index({ organizationId: 1, code: 1 }, { unique: true });
facilitySchema.index({ organizationId: 1, status: 1, _id: -1 });
export const Facility = model('Facility', facilitySchema, 'facilities');

const verificationSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    submittedBy: ref('User'),
    status: {
      type: String,
      enum: ['SUBMITTED', 'APPROVED', 'REJECTED', 'CHANGES_REQUIRED'],
      default: 'SUBMITTED',
    },
    declaration: { type: String, required: true, maxlength: 4000 },
    evidenceReferences: { type: [String], required: true, validate: bounded(20) },
    decisionBy: ref('User', false),
    decisionAt: Date,
    reason: { type: String, maxlength: 4000 },
  },
  aggregateOptions,
);
verificationSchema.index(
  { organizationId: 1 },
  { unique: true, partialFilterExpression: { status: 'SUBMITTED' } },
);
verificationSchema.index({ status: 1, createdAt: 1 });
export const VerificationCase = model('VerificationCase', verificationSchema, 'verificationCases');
