import { Schema, model } from 'mongoose';
import {
  metadataFields,
  aggregateOptions,
  ref,
  nameSchema,
  contactSchema,
  addressSchema,
  bounded,
} from '../../shared/persistence/schema.js';

const practitionerSchema = new Schema(
  {
    ...metadataFields,
    userId: ref('User'),
    name: { type: nameSchema, required: true },
    profession: {
      type: String,
      enum: ['DOCTOR', 'NURSE', 'PHARMACIST', 'THERAPIST', 'LAB_PROFESSIONAL', 'OTHER'],
      required: true,
    },
    birthDate: String,
    contacts: { type: [contactSchema], default: [], validate: bounded(10) },
    residentialAddresses: { type: [addressSchema], default: [], validate: bounded(10) },
    languages: { type: [String], default: ['en'], validate: bounded(30) },
    status: { type: String, enum: ['ACTIVE', 'SUSPENDED', 'RETIRED'], default: 'ACTIVE' },
  },
  aggregateOptions,
);
practitionerSchema.index({ userId: 1 }, { unique: true });
export const Practitioner = model('Practitioner', practitionerSchema, 'practitioners');

const specialtySchema = new Schema(
  {
    ...metadataFields,
    code: { type: String, required: true },
    name: { type: String, required: true },
    parentId: ref('Specialty', false),
    status: { type: String, enum: ['ACTIVE', 'RETIRED'], default: 'ACTIVE' },
  },
  aggregateOptions,
);
specialtySchema.index({ code: 1 }, { unique: true });
export const Specialty = model('Specialty', specialtySchema, 'specialties');

const doctorSchema = new Schema(
  {
    ...metadataFields,
    practitionerId: ref('Practitioner'),
    slug: { type: String, required: true },
    publicName: { type: String, required: true, maxlength: 200 },
    bio: { type: String, required: true, maxlength: 4000 },
    specialtyIds: { type: [Schema.Types.ObjectId], default: [], validate: bounded(30) },
    careerStartDate: String,
    verificationStatus: {
      type: String,
      enum: ['UNVERIFIED', 'IN_REVIEW', 'VERIFIED', 'SUSPENDED'],
      default: 'UNVERIFIED',
    },
    profilePublished: { type: Boolean, default: false },
    verificationCaseId: ref('DoctorVerificationCase', false),
    verifiedUntil: Date,
    authorizationFence: { type: Number, default: 0 },
  },
  aggregateOptions,
);
doctorSchema.index({ practitionerId: 1 }, { unique: true });
doctorSchema.index({ slug: 1 }, { unique: true });
export const Doctor = model('Doctor', doctorSchema, 'doctors');

const qualificationSchema = new Schema(
  {
    ...metadataFields,
    practitionerId: ref('Practitioner'),
    kind: {
      type: String,
      enum: ['DEGREE', 'DIPLOMA', 'FELLOWSHIP', 'CERTIFICATION', 'TRAINING'],
      required: true,
    },
    qualificationName: { type: String, required: true, maxlength: 200 },
    institutionName: { type: String, required: true, maxlength: 200 },
    institutionAddress: addressSchema,
    startDate: String,
    completionDate: String,
    awardYear: Number,
    certificateNumber: { type: String, maxlength: 200 },
    verificationCaseId: ref('DoctorVerificationCase', false),
    lastVerifiedAt: Date,
    evidenceReference: { type: String, required: true, maxlength: 500 },
    status: {
      type: String,
      enum: ['DECLARED', 'VERIFIED', 'REJECTED', 'EXPIRED'],
      default: 'DECLARED',
    },
  },
  aggregateOptions,
);
qualificationSchema.index({ practitionerId: 1, completionDate: -1 });
export const PractitionerQualification = model(
  'PractitionerQualification',
  qualificationSchema,
  'practitionerQualifications',
);

const employmentSchema = new Schema(
  {
    ...metadataFields,
    practitionerId: ref('Practitioner'),
    employerName: { type: String, required: true, maxlength: 200 },
    title: { type: String, required: true, maxlength: 200 },
    employerAddress: addressSchema,
    department: { type: String, required: true, maxlength: 200 },
    startDate: { type: String, required: true },
    endDate: String,
    employmentType: {
      type: String,
      enum: ['FULL_TIME', 'PART_TIME', 'VISITING', 'RESIDENCY', 'INTERNSHIP'],
      required: true,
    },
    description: { type: String, maxlength: 4000 },
    evidenceReference: { type: String, maxlength: 500 },
  },
  aggregateOptions,
);
employmentSchema.index({ practitionerId: 1, startDate: -1 });
export const PractitionerEmployment = model(
  'PractitionerEmployment',
  employmentSchema,
  'practitionerEmployment',
);

const registrationSchema = new Schema(
  {
    ...metadataFields,
    practitionerId: ref('Practitioner'),
    authority: { type: String, required: true, maxlength: 200 },
    jurisdiction: { type: String, required: true, maxlength: 100 },
    registrationNumberNormalized: { type: String, required: true, maxlength: 100 },
    verificationCaseId: ref('DoctorVerificationCase', false),
    lastVerifiedAt: Date,
    issuedOn: String,
    expiresOn: String,
    evidenceReference: { type: String, required: true, maxlength: 500 },
    status: {
      type: String,
      enum: ['DECLARED', 'VERIFIED', 'SUSPENDED', 'EXPIRED', 'REJECTED'],
      default: 'DECLARED',
    },
  },
  aggregateOptions,
);
registrationSchema.index(
  { practitionerId: 1, authority: 1, jurisdiction: 1, registrationNumberNormalized: 1 },
  { unique: true },
);
registrationSchema.index(
  { authority: 1, jurisdiction: 1, registrationNumberNormalized: 1 },
  { unique: true, partialFilterExpression: { status: 'VERIFIED' } },
);
registrationSchema.index({ practitionerId: 1, status: 1 });
export const ProfessionalRegistration = model(
  'ProfessionalRegistration',
  registrationSchema,
  'professionalRegistrations',
);
