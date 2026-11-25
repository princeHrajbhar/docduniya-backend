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
const text = (max: number, required = false) => ({ type: String, maxlength: max, required });

export const codingSchema = new Schema(
  { system: text(200, true), code: text(100, true), display: text(200, true), version: text(60) },
  value,
);
/** Text plus optional codings; display snapshots are preserved with the code. */
export const conceptSchema = new Schema(
  { text: text(500, true), codings: { type: [codingSchema], default: [], validate: bounded(5) } },
  value,
);
const provenanceSchema = new Schema(
  {
    source: { type: String, enum: ['PATIENT', 'CLINICIAN', 'DEVICE', 'IMPORT'], required: true },
    recordedAt: { type: Date, required: true },
    recordedBy: { type: actorSchema, required: true },
    effectiveAt: Date,
    sourceDocumentId: ref('ClinicalDocument', false),
  },
  value,
);
const quantitySchema = new Schema(
  {
    value: { type: Schema.Types.Decimal128, required: true },
    unit: text(40, true),
    system: text(100),
  },
  value,
);

/** Custody shared by every clinical record: organization, patient and that organization's registration. */
const custody = {
  organizationId: ref('Organization'),
  patientId: ref('Patient'),
  patientRegistrationId: ref('PatientRegistration'),
  /** Facility holding the record; drives branch-restricted access. */
  facilityId: ref('Facility'),
  encounterId: ref('Encounter', false),
  provenance: { type: provenanceSchema, required: true },
};
/** Signable head: signed content lives in immutable clinicalRevisions. */
const head = {
  status: {
    type: String,
    enum: ['DRAFT', 'SIGNED', 'AMENDED', 'ENTERED_IN_ERROR'],
    default: 'DRAFT',
  },
  currentRevisionId: ref('ClinicalRevision', false),
  signedAt: Date,
  signedBy: ref('Practitioner', false),
  correctionReason: text(1000),
};
const clinical = <T extends object>(fields: T) =>
  new Schema({ ...metadataFields, ...custody, ...fields }, aggregateOptions);

// ── Visits, encounters and care teams ────────────────────────────────────────
const visitSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    patientId: ref('Patient'),
    patientRegistrationId: ref('PatientRegistration'),
    facilityId: ref('Facility'),
    type: {
      type: String,
      enum: ['OUTPATIENT', 'INPATIENT', 'EMERGENCY', 'TELEHEALTH'],
      required: true,
    },
    appointmentId: ref('Appointment', false),
    startedAt: { type: Date, required: true },
    endedAt: Date,
    status: { type: String, enum: ['OPEN', 'CLOSED', 'ENTERED_IN_ERROR'], default: 'OPEN' },
    correctionReason: text(1000),
  },
  aggregateOptions,
);
visitSchema.index({ organizationId: 1, patientId: 1, startedAt: -1 });
visitSchema.index({ organizationId: 1, facilityId: 1, status: 1 });
export const Visit = model('Visit', visitSchema, 'visits');

const encounterSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    patientId: ref('Patient'),
    patientRegistrationId: ref('PatientRegistration'),
    visitId: ref('Visit'),
    appointmentId: ref('Appointment', false),
    facilityId: ref('Facility'),
    type: { type: conceptSchema, required: true },
    mode: { type: String, enum: ['IN_PERSON', 'VIDEO', 'AUDIO'], default: 'IN_PERSON' },
    telemedicineConsentId: ref('Consent', false),
    responsiblePractitionerId: ref('Practitioner'),
    status: {
      type: String,
      enum: ['PLANNED', 'IN_PROGRESS', 'FINISHED', 'CANCELLED', 'ENTERED_IN_ERROR'],
      default: 'IN_PROGRESS',
    },
    startedAt: Date,
    endedAt: Date,
    chiefComplaint: text(2000, true),
    documentationStatus: {
      type: String,
      enum: ['INCOMPLETE', 'READY', 'SIGNED'],
      default: 'INCOMPLETE',
    },
  },
  aggregateOptions,
);
encounterSchema.index({ organizationId: 1, patientId: 1, startedAt: -1 });
encounterSchema.index({ appointmentId: 1 });
encounterSchema.index({ visitId: 1 });
export const Encounter = model('Encounter', encounterSchema, 'encounters');

const careTeamSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    patientId: ref('Patient'),
    patientRegistrationId: ref('PatientRegistration'),
    facilityId: ref('Facility', false),
    membershipValidFrom: Date,
    authorizationFence: { type: Number, default: 0 },
    visitId: ref('Visit', false),
    practitionerId: ref('Practitioner'),
    userId: ref('User'),
    roleCode: {
      type: String,
      enum: ['ATTENDING', 'CONSULTING', 'NURSING', 'ALLIED'],
      required: true,
    },
    periodStart: { type: Date, required: true },
    periodEnd: Date,
    status: { type: String, enum: ['ACTIVE', 'ENDED'], default: 'ACTIVE' },
  },
  aggregateOptions,
);
careTeamSchema.index({ organizationId: 1, patientId: 1, userId: 1, status: 1 });
careTeamSchema.index({ practitionerId: 1, status: 1 });
export const CareTeamAssignment = model(
  'CareTeamAssignment',
  careTeamSchema,
  'careTeamAssignments',
);

// ── Longitudinal clinical facts ──────────────────────────────────────────────
const allergySchema = clinical({
  substance: { type: conceptSchema, required: true },
  category: { type: String, enum: ['DRUG', 'FOOD', 'ENVIRONMENT', 'OTHER'], required: true },
  clinicalStatus: { type: String, enum: ['ACTIVE', 'INACTIVE', 'RESOLVED'], required: true },
  verificationStatus: {
    type: String,
    enum: ['UNCONFIRMED', 'CONFIRMED', 'REFUTED', 'ENTERED_IN_ERROR'],
    required: true,
  },
  criticality: { type: String, enum: ['LOW', 'HIGH', 'UNABLE_TO_ASSESS'], required: true },
  reactions: {
    type: [
      new Schema(
        {
          manifestation: { type: conceptSchema, required: true },
          severity: { type: String, enum: ['MILD', 'MODERATE', 'SEVERE'] },
        },
        value,
      ),
    ],
    default: [],
    validate: bounded(20),
  },
  onset: Date,
  note: text(2000),
  currentRevisionId: ref('ClinicalRevision', false),
  revisionCount: { type: Number, default: 0 },
});
allergySchema.index({ organizationId: 1, patientId: 1, clinicalStatus: 1 });
export const Allergy = model('Allergy', allergySchema, 'allergies');

const conditionSchema = clinical({
  code: { type: conceptSchema, required: true },
  clinicalStatus: {
    type: String,
    enum: ['ACTIVE', 'RECURRENCE', 'REMISSION', 'RESOLVED', 'INACTIVE'],
    required: true,
  },
  verificationStatus: {
    type: String,
    enum: ['PROVISIONAL', 'DIFFERENTIAL', 'CONFIRMED', 'REFUTED', 'ENTERED_IN_ERROR'],
    required: true,
  },
  onset: Date,
  abatement: Date,
  severity: { type: String, enum: ['MILD', 'MODERATE', 'SEVERE'] },
  note: text(2000),
  currentRevisionId: ref('ClinicalRevision', false),
  revisionCount: { type: Number, default: 0 },
});
conditionSchema.index({ organizationId: 1, patientId: 1, clinicalStatus: 1 });
export const Condition = model('Condition', conditionSchema, 'conditions');

const medicationStatementSchema = clinical({
  medication: { type: conceptSchema, required: true },
  drugId: ref('DrugCatalogItem', false),
  status: {
    type: String,
    enum: ['ACTIVE', 'STOPPED', 'COMPLETED', 'UNKNOWN', 'NOT_TAKEN'],
    required: true,
  },
  dosageText: text(1000),
  periodStart: Date,
  periodEnd: Date,
  sourcePrescriptionItemId: ref('PrescriptionItem', false),
  currentRevisionId: ref('ClinicalRevision', false),
  revisionCount: { type: Number, default: 0 },
});
medicationStatementSchema.index({ organizationId: 1, patientId: 1, status: 1 });
export const MedicationStatement = model(
  'MedicationStatement',
  medicationStatementSchema,
  'medicationStatements',
);

const immunizationSchema = clinical({
  vaccine: { type: conceptSchema, required: true },
  status: { type: String, enum: ['COMPLETED', 'NOT_DONE', 'ENTERED_IN_ERROR'], required: true },
  occurrenceAt: { type: Date, required: true },
  doseText: text(100),
  lotNumber: text(60),
  route: text(60),
  site: text(60),
  performerId: ref('Practitioner', false),
  primarySource: { type: Boolean, required: true },
  reasonNotDone: text(1000),
  currentRevisionId: ref('ClinicalRevision', false),
  revisionCount: { type: Number, default: 0 },
});
immunizationSchema.index({ organizationId: 1, patientId: 1, occurrenceAt: -1 });
export const Immunization = model('Immunization', immunizationSchema, 'immunizations');

// ── Observations and documentation ───────────────────────────────────────────
const observationSchema = clinical({
  category: {
    type: String,
    enum: ['VITAL_SIGNS', 'LABORATORY', 'EXAM', 'IMAGING', 'SOCIAL'],
    required: true,
  },
  code: { type: conceptSchema, required: true },
  valueType: { type: String, enum: ['QUANTITY', 'TEXT', 'CODE', 'BOOLEAN'], required: true },
  valueQuantity: quantitySchema,
  valueText: text(4000),
  valueCode: conceptSchema,
  valueBoolean: Boolean,
  status: {
    type: String,
    enum: ['PRELIMINARY', 'FINAL', 'AMENDED', 'CANCELLED', 'ENTERED_IN_ERROR'],
    default: 'PRELIMINARY',
  },
  effectiveAt: { type: Date, required: true },
  referenceRange: {
    type: new Schema(
      {
        low: Schema.Types.Decimal128,
        high: Schema.Types.Decimal128,
        unit: text(40),
        text: text(200),
      },
      value,
    ),
  },
  interpretation: {
    type: String,
    enum: ['NORMAL', 'LOW', 'HIGH', 'CRITICAL_LOW', 'CRITICAL_HIGH', 'ABNORMAL'],
  },
  serviceOrderId: ref('ServiceOrder', false),
  specimenId: ref('Specimen', false),
  admissionId: ref('Admission', false),
  performerId: ref('Practitioner', false),
  currentRevisionId: ref('ClinicalRevision', false),
  revisionCount: { type: Number, default: 0 },
  correctionReason: text(1000),
});
observationSchema.pre('validate', function () {
  const present: Record<string, unknown> = {
    QUANTITY: this.get('valueQuantity'),
    TEXT: this.get('valueText'),
    CODE: this.get('valueCode'),
    BOOLEAN: typeof this.get('valueBoolean') === 'boolean' ? true : undefined,
  };
  const count = Object.values(present).filter(
    (entry) => entry !== undefined && entry !== null,
  ).length;
  if (count !== 1 || !present[String(this.get('valueType'))])
    throw new Error('An observation has exactly one value of its declared type');
});
observationSchema.index({
  organizationId: 1,
  patientId: 1,
  'code.codings.code': 1,
  effectiveAt: -1,
});
observationSchema.index({ serviceOrderId: 1 });
observationSchema.index({ admissionId: 1, effectiveAt: 1 });
export const Observation = model('Observation', observationSchema, 'observations');

const noteSchema = clinical({
  noteType: {
    type: String,
    enum: ['CONSULTATION', 'PROGRESS', 'DISCHARGE_SUMMARY', 'NURSING', 'PROCEDURE', 'ADDENDUM'],
    required: true,
  },
  authorId: ref('Practitioner'),
  sections: {
    type: new Schema(
      {
        history: text(32_000),
        examination: text(32_000),
        assessment: text(32_000),
        plan: text(32_000),
      },
      value,
    ),
    required: true,
  },
  reviewState: {
    type: new Schema(
      {
        allergies: {
          type: String,
          enum: ['UNKNOWN', 'REVIEWED', 'NONE_KNOWN'],
          default: 'UNKNOWN',
        },
        medications: {
          type: String,
          enum: ['UNKNOWN', 'REVIEWED', 'NONE_KNOWN'],
          default: 'UNKNOWN',
        },
      },
      value,
    ),
    default: {},
  },
  ...head,
  revisionCount: { type: Number, default: 0 },
  addendumToId: ref('ClinicalNote', false),
  releasedToPatientAt: Date,
});
noteSchema.index({ organizationId: 1, encounterId: 1, createdAt: -1 });
noteSchema.index({ organizationId: 1, patientId: 1, status: 1 });
export const ClinicalNote = model('ClinicalNote', noteSchema, 'clinicalNotes');

const diagnosisSchema = clinical({
  conditionId: ref('Condition', false),
  code: { type: conceptSchema, required: true },
  rank: { type: Number, required: true, min: 1, max: 50 },
  use: { type: String, enum: ['PRIMARY', 'SECONDARY', 'ADMISSION', 'DISCHARGE'], required: true },
  certainty: {
    type: String,
    enum: ['PROVISIONAL', 'DIFFERENTIAL', 'CONFIRMED', 'REFUTED'],
    required: true,
  },
  authorId: ref('Practitioner'),
  ...head,
  revisionCount: { type: Number, default: 0 },
});
diagnosisSchema.index({ organizationId: 1, encounterId: 1, rank: 1 });
diagnosisSchema.index({ organizationId: 1, patientId: 1, status: 1 });
export const Diagnosis = model('Diagnosis', diagnosisSchema, 'diagnoses');

// ── Prescriptions ────────────────────────────────────────────────────────────
const prescriptionSchema = clinical({
  number: text(40),
  prescriberId: ref('Practitioner'),
  registrationId: ref('ProfessionalRegistration', false),
  issuedAt: Date,
  validUntil: Date,
  ...head,
  revisionCount: { type: Number, default: 0 },
  itemCount: { type: Number, default: 0, min: 0, max: 100 },
  supersedesId: ref('Prescription', false),
  patientSnapshot: {
    type: new Schema({ name: text(200, true), birthDate: text(10) }, value),
    required: true,
  },
  prescriberSnapshot: {
    type: new Schema(
      {
        name: text(200, true),
        registrationNumber: text(100),
        registrationAuthority: text(200),
        facilityName: text(200),
      },
      value,
    ),
  },
});
prescriptionSchema.index(
  { organizationId: 1, number: 1 },
  { unique: true, partialFilterExpression: { number: { $type: 'string' } } },
);
prescriptionSchema.index({ organizationId: 1, patientId: 1, issuedAt: -1 });
export const Prescription = model('Prescription', prescriptionSchema, 'prescriptions');

export const doseSchema = new Schema(
  {
    doseValue: Schema.Types.Decimal128,
    doseUnit: text(40),
    route: text(60, true),
    frequencyPerDay: { type: Number, min: 0, max: 48 },
    timesOfDay: { type: [String], default: [], validate: bounded(12) },
    asNeeded: { type: Boolean, default: false },
    asNeededReason: text(200),
    durationDays: { type: Number, min: 1, max: 3650 },
    instructions: text(1000, true),
  },
  value,
);
const prescriptionItemSchema = clinical({
  prescriptionId: ref('Prescription'),
  lineNumber: { type: Number, required: true, min: 1, max: 100 },
  drugId: ref('DrugCatalogItem', false),
  medication: {
    type: new Schema({ name: text(200, true), form: text(100, true), strength: text(100) }, value),
    required: true,
  },
  dosage: { type: [doseSchema], required: true, validate: bounded(10) },
  quantity: {
    type: new Schema(
      { value: { type: Number, required: true, min: 1, max: 100_000 }, unit: text(40, true) },
      value,
    ),
    required: true,
  },
  refillsAllowed: { type: Number, default: 0, min: 0, max: 12 },
  substitutionAllowed: { type: Boolean, default: true },
  instructions: text(1000),
  status: {
    type: String,
    enum: ['DRAFT', 'ACTIVE', 'COMPLETED', 'STOPPED', 'ENTERED_IN_ERROR'],
    default: 'DRAFT',
  },
  stopReason: text(1000),
  stoppedAt: Date,
  /** Cumulative supplied quantity, maintained only by finalized dispenses under the item guard. */
  dispensedQuantity: { type: Number, default: 0, min: 0 },
  fulfillmentStatus: {
    type: String,
    enum: ['UNFILLED', 'PARTIAL', 'FULFILLED'],
    default: 'UNFILLED',
  },
});
prescriptionItemSchema.index(
  { organizationId: 1, prescriptionId: 1, lineNumber: 1 },
  { unique: true },
);
prescriptionItemSchema.index({ organizationId: 1, patientId: 1, status: 1 });
export const PrescriptionItem = model(
  'PrescriptionItem',
  prescriptionItemSchema,
  'prescriptionItems',
);

// ── Immutable revisions and signatures ───────────────────────────────────────
export const SIGNABLE = [
  'clinicalNote',
  'diagnosis',
  'prescription',
  'allergy',
  'condition',
  'medicationStatement',
  'observation',
  'immunization',
  'diagnosticReport',
  'serviceOrder',
] as const;
export type SignableType = (typeof SIGNABLE)[number];
const revisionSchema = new Schema(
  {
    organizationId: ref('Organization'),
    patientId: ref('Patient'),
    facilityId: ref('Facility', false),
    resource: {
      type: new Schema(
        {
          type: { type: String, enum: SIGNABLE, required: true },
          id: { type: Schema.Types.ObjectId, required: true },
        },
        value,
      ),
      required: true,
    },
    revisionNumber: { type: Number, required: true, min: 1 },
    previousRevisionId: ref('ClinicalRevision', false),
    kind: {
      type: String,
      enum: ['SIGNED', 'AMENDED', 'RECORDED', 'ENTERED_IN_ERROR'],
      required: true,
    },
    contentSchemaVersion: { type: Number, required: true },
    /** Canonical JSON produced by the resource's typed snapshot builder. */
    snapshot: { type: String, required: true, maxlength: 400_000 },
    canonicalHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    reason: text(1000, true),
    authorId: ref('Practitioner', false),
    recordedBy: { type: actorSchema, required: true },
    signedAt: Date,
    signatureId: Schema.Types.ObjectId,
    createdAt: { type: Date, default: Date.now },
  },
  appendOnly,
);
revisionSchema.index(
  { organizationId: 1, 'resource.type': 1, 'resource.id': 1, revisionNumber: 1 },
  { unique: true },
);
revisionSchema.index({ patientId: 1, createdAt: -1 });
revisionSchema.pre('save', function () {
  if (!this.isNew) throw new Error('Clinical revisions are immutable');
});
revisionSchema.pre(
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
    throw new Error('Clinical revisions are immutable');
  },
);
export const ClinicalRevision = model('ClinicalRevision', revisionSchema, 'clinicalRevisions');

const signatureSchema = new Schema(
  {
    organizationId: ref('Organization'),
    patientId: ref('Patient'),
    revisionId: ref('ClinicalRevision'),
    signerId: ref('Practitioner'),
    userId: ref('User'),
    signedAt: { type: Date, required: true },
    method: { type: String, enum: ['AUTHENTICATED_ATTESTATION'], required: true },
    contentHash: { type: String, required: true },
    authLevel: { type: String, enum: ['SINGLE_FACTOR', 'MFA'], required: true },
    sessionId: text(100),
    purpose: { type: String, enum: ['AUTHOR', 'VERIFIER'], required: true },
    attestation: text(500, true),
    createdAt: { type: Date, default: Date.now },
  },
  appendOnly,
);
signatureSchema.index(
  { organizationId: 1, revisionId: 1, signerId: 1, purpose: 1 },
  { unique: true },
);
signatureSchema.pre('save', function () {
  if (!this.isNew) throw new Error('Signatures are immutable');
});
signatureSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany'],
  () => {
    throw new Error('Signatures are immutable');
  },
);
export const RecordSignature = model('RecordSignature', signatureSchema, 'recordSignatures');

// ── Tasks and referrals ──────────────────────────────────────────────────────
const taskSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    patientId: ref('Patient'),
    patientRegistrationId: ref('PatientRegistration'),
    kind: {
      type: String,
      enum: ['FOLLOW_UP', 'RESULT_REVIEW', 'CRITICAL_RESULT', 'REFERRAL', 'NURSING', 'OTHER'],
      required: true,
    },
    title: text(200, true),
    sourceRef: {
      type: new Schema(
        { type: text(60, true), id: { type: Schema.Types.ObjectId, required: true } },
        value,
      ),
      required: true,
    },
    assigneeId: ref('Practitioner', false),
    dueAt: { type: Date, required: true },
    priority: { type: String, enum: ['ROUTINE', 'URGENT', 'CRITICAL'], required: true },
    status: {
      type: String,
      enum: ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'DONE', 'CANCELLED'],
      default: 'OPEN',
    },
    acknowledgedAt: Date,
    acknowledgedBy: ref('Practitioner', false),
    completedAt: Date,
    outcome: text(2000),
    escalationLevel: { type: Number, default: 0, min: 0, max: 10 },
    nextEscalationAt: Date,
  },
  aggregateOptions,
);
taskSchema.index({ organizationId: 1, status: 1, dueAt: 1 });
taskSchema.index({ assigneeId: 1, status: 1, dueAt: 1 });
taskSchema.index({ status: 1, nextEscalationAt: 1 });
export const ClinicalTask = model('ClinicalTask', taskSchema, 'clinicalTasks');

const referralSchema = clinical({
  fromPractitionerId: ref('Practitioner'),
  toOrganizationId: ref('Organization', false),
  toSpecialtyId: ref('Specialty', false),
  reason: { type: conceptSchema, required: true },
  priority: { type: String, enum: ['ROUTINE', 'URGENT'], required: true },
  status: {
    type: String,
    enum: ['DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'COMPLETED', 'CANCELLED'],
    default: 'DRAFT',
  },
  note: text(4000),
  respondedAt: Date,
  responseReason: text(1000),
});
referralSchema.index({ organizationId: 1, patientId: 1, createdAt: -1 });
referralSchema.index({ toOrganizationId: 1, status: 1 });
export const Referral = model('Referral', referralSchema, 'referrals');
