import { Schema, model } from 'mongoose';
import {
  aggregateOptions,
  metadataFields,
  nameSchema,
  ref,
  bounded,
} from '../../shared/persistence/schema.js';

const valueOptions = { _id: false, strict: 'throw', versionKey: false } as const;
const registrationSnapshot = new Schema(
  {
    id: ref('ProfessionalRegistration'),
    version: { type: Number, required: true },
    authority: { type: String, required: true },
    jurisdiction: { type: String, required: true },
    registrationNumberNormalized: { type: String, required: true },
    issuedOn: String,
    expiresOn: String,
    evidenceReference: { type: String, required: true },
  },
  valueOptions,
);
const qualificationSnapshot = new Schema(
  {
    id: ref('PractitionerQualification'),
    version: { type: Number, required: true },
    kind: { type: String, required: true },
    qualificationName: { type: String, required: true },
    institutionName: { type: String, required: true },
    awardYear: Number,
    completionDate: String,
    certificateNumber: String,
    evidenceReference: { type: String, required: true },
  },
  valueOptions,
);
const verificationSchema = new Schema(
  {
    ...metadataFields,
    doctorId: ref('Doctor'),
    practitionerId: ref('Practitioner'),
    submittedBy: ref('User'),
    identitySnapshot: {
      type: new Schema(
        { name: { type: nameSchema, required: true }, birthDate: String },
        valueOptions,
      ),
      required: true,
    },
    profileSnapshot: {
      type: new Schema(
        {
          publicName: { type: String, required: true },
          bio: { type: String, required: true },
          specialtyIds: { type: [Schema.Types.ObjectId], required: true, validate: bounded(30) },
        },
        valueOptions,
      ),
      required: true,
    },
    registrationSnapshot: { type: registrationSnapshot, required: true },
    qualificationSnapshots: {
      type: [qualificationSnapshot],
      required: true,
      validate: bounded(20),
    },
    declaration: { type: String, required: true, maxlength: 4000 },
    status: {
      type: String,
      enum: ['SUBMITTED', 'APPROVED', 'REJECTED', 'CHANGES_REQUIRED', 'WITHDRAWN'],
      default: 'SUBMITTED',
    },
    decisionBy: ref('User', false),
    decisionAt: Date,
    validUntil: Date,
    reason: { type: String, maxlength: 4000 },
    checks: new Schema(
      { identityChecked: Boolean, registrationChecked: Boolean, qualificationsChecked: Boolean },
      valueOptions,
    ),
  },
  aggregateOptions,
);
verificationSchema.index(
  { doctorId: 1 },
  { unique: true, partialFilterExpression: { status: 'SUBMITTED' } },
);
verificationSchema.index({ status: 1, _id: -1 });
verificationSchema.index({ submittedBy: 1, _id: -1 });
export const DoctorVerificationCase = model(
  'DoctorVerificationCase',
  verificationSchema,
  'doctorVerificationCases',
);

const affiliationSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    facilityId: ref('Facility'),
    doctorId: ref('Doctor'),
    invitedBy: ref('User'),
    acceptedBy: ref('User', false),
    acceptedAt: Date,
    membershipId: ref('Membership', false),
    membershipValidFrom: Date,
    authorizationFence: { type: Number, default: 0 },
    title: { type: String, required: true, maxlength: 200 },
    department: { type: String, required: true, maxlength: 200 },
    status: {
      type: String,
      enum: ['PENDING', 'ACTIVE', 'SUSPENDED', 'ENDED', 'REJECTED'],
      default: 'PENDING',
    },
    invitationExpiresAt: { type: Date, required: true },
    validFrom: { type: Date, required: true },
    validUntil: Date,
    reason: { type: String, maxlength: 1000 },
  },
  aggregateOptions,
);
affiliationSchema.index(
  { organizationId: 1, doctorId: 1, facilityId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ['PENDING', 'ACTIVE', 'SUSPENDED'] } },
  },
);
affiliationSchema.index({ doctorId: 1, status: 1, _id: -1 });
affiliationSchema.index({ organizationId: 1, facilityId: 1, _id: -1 });
affiliationSchema.index({ status: 1, _id: -1 });
export const DoctorAffiliation = model(
  'DoctorAffiliation',
  affiliationSchema,
  'doctorAffiliations',
);
