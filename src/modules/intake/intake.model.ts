import { Schema, model } from 'mongoose';
import {
  aggregateOptions,
  actorSchema,
  bounded,
  metadataFields,
  ref,
} from '../../shared/persistence/schema.js';

const value = { _id: false, strict: 'throw', versionKey: false } as const;

const optionSchema = new Schema(
  {
    code: { type: String, required: true, maxlength: 60 },
    display: { type: String, required: true, maxlength: 200 },
    /** Selecting this option is a red flag that needs urgent attention. */
    redFlag: { type: Boolean, default: false },
  },
  value,
);
const itemSchema = new Schema(
  {
    linkId: { type: String, required: true, maxlength: 60 },
    text: { type: String, required: true, maxlength: 500 },
    type: {
      type: String,
      enum: ['BOOLEAN', 'CHOICE', 'MULTI_CHOICE', 'TEXT', 'NUMBER', 'DATE'],
      required: true,
    },
    required: { type: Boolean, default: false },
    options: { type: [optionSchema], default: [], validate: bounded(30) },
    /** BOOLEAN items: answering yes is a red flag. */
    redFlagIfTrue: { type: Boolean, default: false },
    min: Number,
    max: Number,
    /** Shown only when another item has the given answer. */
    enableWhen: {
      type: new Schema(
        { linkId: { type: String, required: true }, equals: { type: String, required: true } },
        value,
      ),
    },
  },
  value,
);

/**
 * Versioned intake questionnaire. Platform questionnaires are reusable templates; providers may
 * publish their own. A published version is immutable: changes publish a new version.
 */
const questionnaireSchema = new Schema(
  {
    ...metadataFields,
    scopeKey: { type: String, required: true, maxlength: 80 },
    organizationId: ref('Organization', false),
    code: { type: String, required: true, maxlength: 80 },
    questionnaireVersion: { type: Number, required: true, min: 1 },
    title: { type: String, required: true, maxlength: 200 },
    description: { type: String, maxlength: 2000 },
    language: { type: String, default: 'en', maxlength: 10 },
    items: { type: [itemSchema], required: true, validate: bounded(60) },
    status: { type: String, enum: ['DRAFT', 'PUBLISHED', 'RETIRED'], default: 'DRAFT' },
    contentHash: { type: String, maxlength: 64 },
    publishedAt: Date,
  },
  aggregateOptions,
);
questionnaireSchema.index({ scopeKey: 1, code: 1, questionnaireVersion: 1 }, { unique: true });
questionnaireSchema.index({ scopeKey: 1, status: 1 });
export const Questionnaire = model('Questionnaire', questionnaireSchema, 'questionnaires');

/** The questionnaire a service offering asks patients to complete before the visit. */
const assignmentSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    offeringId: ref('ServiceOffering'),
    questionnaireId: ref('Questionnaire'),
    required: { type: Boolean, default: true },
    status: { type: String, enum: ['ACTIVE', 'ENDED'], default: 'ACTIVE' },
  },
  aggregateOptions,
);
assignmentSchema.index(
  { offeringId: 1 },
  { unique: true, partialFilterExpression: { status: 'ACTIVE' } },
);
export const QuestionnaireAssignment = model(
  'QuestionnaireAssignment',
  assignmentSchema,
  'questionnaireAssignments',
);

const answerSchema = new Schema(
  {
    linkId: { type: String, required: true, maxlength: 60 },
    valueBoolean: Boolean,
    valueString: { type: String, maxlength: 4000 },
    valueCodes: { type: [String], default: undefined },
    valueNumber: Number,
    valueDate: String,
  },
  value,
);

/**
 * Patient-reported intake for one appointment. Content is patient-authored health information:
 * it is visible to the appointment's clinician and care team, never to administration alone.
 */
const responseSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    facilityId: ref('Facility'),
    patientId: ref('Patient'),
    appointmentId: ref('Appointment'),
    questionnaireId: ref('Questionnaire'),
    questionnaireSnapshot: {
      type: new Schema(
        {
          code: { type: String, required: true },
          questionnaireVersion: { type: Number, required: true },
          contentHash: { type: String, required: true },
          title: { type: String, required: true },
        },
        value,
      ),
      required: true,
    },
    answers: { type: [answerSchema], default: [], validate: bounded(60) },
    redFlags: { type: [String], default: [] },
    submittedBy: { type: actorSchema, required: true },
    status: { type: String, enum: ['SUBMITTED', 'SUPERSEDED', 'REVIEWED'], default: 'SUBMITTED' },
    supersedesId: ref('IntakeResponse', false),
    reviewedBy: ref('Practitioner', false),
    reviewedAt: Date,
  },
  aggregateOptions,
);
responseSchema.index(
  { appointmentId: 1, questionnaireId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['SUBMITTED', 'REVIEWED'] } } },
);
responseSchema.index({ patientId: 1, _id: -1 });
export const IntakeResponse = model('IntakeResponse', responseSchema, 'intakeResponses');

/**
 * Governed mapping from a patient-described concern to specialties and urgency. It routes a
 * search; it never diagnoses. Activation needs a second reviewer (two-person rule).
 */
const concernSchema = new Schema(
  {
    ...metadataFields,
    code: { type: String, required: true, maxlength: 80 },
    display: { type: String, required: true, maxlength: 200 },
    synonyms: { type: [String], default: [], validate: bounded(30) },
    specialtyIds: { type: [Schema.Types.ObjectId], default: [], validate: bounded(10) },
    urgency: { type: String, enum: ['ROUTINE', 'URGENT', 'EMERGENCY'], required: true },
    advice: { type: String, required: true, maxlength: 1000 },
    minAgeYears: Number,
    maxAgeYears: Number,
    status: { type: String, enum: ['DRAFT', 'ACTIVE', 'RETIRED'], default: 'DRAFT' },
    proposedBy: ref('User'),
    approvedBy: ref('User', false),
    approvedAt: Date,
    searchText: { type: String, maxlength: 4000 },
  },
  aggregateOptions,
);
concernSchema.index({ code: 1 }, { unique: true, partialFilterExpression: { status: 'ACTIVE' } });
concernSchema.index({ status: 1, searchText: 1 });
export const ConcernMapping = model('ConcernMapping', concernSchema, 'concernMappings');
