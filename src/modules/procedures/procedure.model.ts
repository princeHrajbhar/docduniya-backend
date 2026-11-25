import { Schema, model } from 'mongoose';
import { aggregateOptions, bounded, metadataFields, ref } from '../../shared/persistence/schema.js';
import { conceptSchema } from '../clinical/clinical.model.js';

const value = { _id: false, strict: 'throw', versionKey: false } as const;

/** WHO Surgical Safety Checklist phases and their required confirmations. */
export const CHECKLIST = {
  SIGN_IN: [
    'IDENTITY_CONFIRMED',
    'SITE_MARKED',
    'CONSENT_CONFIRMED',
    'ANAESTHESIA_CHECK_COMPLETE',
    'ALLERGIES_REVIEWED',
    'AIRWAY_RISK_ASSESSED',
    'BLOOD_LOSS_RISK_ASSESSED',
  ],
  TIME_OUT: [
    'TEAM_INTRODUCED',
    'PATIENT_SITE_PROCEDURE_CONFIRMED',
    'ANTIBIOTIC_PROPHYLAXIS_CONSIDERED',
    'CRITICAL_EVENTS_REVIEWED',
    'IMAGING_DISPLAYED',
  ],
  SIGN_OUT: [
    'PROCEDURE_RECORDED',
    'COUNTS_CORRECT',
    'SPECIMENS_LABELLED',
    'EQUIPMENT_ISSUES_ADDRESSED',
    'RECOVERY_CONCERNS_REVIEWED',
  ],
} as const;
export type ChecklistPhase = keyof typeof CHECKLIST;

const teamSchema = new Schema(
  {
    userId: ref('User'),
    practitionerId: ref('Practitioner'),
    role: {
      type: String,
      enum: ['SURGEON', 'ASSISTANT', 'ANAESTHETIST', 'SCRUB_NURSE', 'CIRCULATING_NURSE'],
      required: true,
    },
  },
  value,
);
const phaseSchema = new Schema(
  {
    completedAt: { type: Date, required: true },
    completedBy: ref('Practitioner'),
    confirmed: { type: [String], required: true },
    notes: { type: String, maxlength: 1000 },
  },
  value,
);

/**
 * A theatre case from request to completion. Scheduling never double-books a theatre (overlap
 * checked under a per-theatre lock); each safety-checklist phase must be complete, in order,
 * before the case progresses.
 */
const procedureSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    facilityId: ref('Facility'),
    patientId: ref('Patient'),
    patientRegistrationId: ref('PatientRegistration'),
    encounterId: ref('Encounter'),
    admissionId: ref('Admission', false),
    number: { type: String, required: true, maxlength: 40 },
    procedure: { type: conceptSchema, required: true },
    laterality: {
      type: String,
      enum: ['LEFT', 'RIGHT', 'BILATERAL', 'NOT_APPLICABLE'],
      required: true,
    },
    priority: { type: String, enum: ['ELECTIVE', 'URGENT', 'EMERGENCY'], required: true },
    requestedBy: ref('Practitioner'),
    estimatedMinutes: { type: Number, required: true, min: 10, max: 1440 },
    theatreId: ref('FacilityLocation', false),
    scheduledStart: Date,
    scheduledEnd: Date,
    team: { type: [teamSchema], default: [], validate: bounded(12) },
    status: {
      type: String,
      enum: ['REQUESTED', 'SCHEDULED', 'IN_THEATRE', 'COMPLETED', 'CANCELLED'],
      default: 'REQUESTED',
    },
    signIn: phaseSchema,
    timeOut: phaseSchema,
    signOut: phaseSchema,
    actualStart: Date,
    actualEnd: Date,
    outcomeSummary: { type: String, maxlength: 4000 },
    operativeNoteId: ref('ClinicalNote', false),
    cancellationReason: { type: String, maxlength: 1000 },
  },
  aggregateOptions,
);
procedureSchema.index({ organizationId: 1, number: 1 }, { unique: true });
procedureSchema.index({ theatreId: 1, status: 1, scheduledStart: 1 });
procedureSchema.index({ organizationId: 1, patientId: 1, _id: -1 });
export const ProcedureCase = model('ProcedureCase', procedureSchema, 'procedureCases');

/** Serialization point for scheduling one theatre: every booking transaction writes it. */
const theatreLockSchema = new Schema(
  { theatreId: ref('FacilityLocation'), fence: { type: Number, default: 0 } },
  { strict: 'throw', versionKey: false, autoIndex: false, autoCreate: false },
);
theatreLockSchema.index({ theatreId: 1 }, { unique: true });
export const TheatreLock = model('TheatreLock', theatreLockSchema, 'theatreLocks');
