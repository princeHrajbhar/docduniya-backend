import { Schema, model } from 'mongoose';
import {
  actorSchema,
  aggregateOptions,
  bounded,
  metadataFields,
  ref,
} from '../../shared/persistence/schema.js';
import { conceptSchema } from '../clinical/clinical.model.js';

const value = { _id: false, strict: 'throw', versionKey: false } as const;
const appendOnly = {
  strict: 'throw',
  versionKey: false,
  autoIndex: false,
  autoCreate: false,
} as const;
const text = (max: number, required = false) => ({ type: String, maxlength: max, required });
const custody = {
  organizationId: ref('Organization'),
  patientId: ref('Patient'),
  patientRegistrationId: ref('PatientRegistration'),
};
const sealed = (schema: Schema, label: string) => {
  schema.pre('save', function () {
    if (!this.isNew) throw new Error(`${label} entries are append-only`);
  });
  schema.pre(
    ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany'],
    () => {
      throw new Error(`${label} entries are append-only`);
    },
  );
};

const admissionSchema = new Schema(
  {
    ...metadataFields,
    ...custody,
    visitId: ref('Visit'),
    facilityId: ref('Facility'),
    admissionNumber: text(40, true),
    admittingPractitionerId: ref('Practitioner'),
    type: { type: String, enum: ['ELECTIVE', 'EMERGENCY', 'TRANSFER'], required: true },
    reason: { type: conceptSchema, required: true },
    requestedAt: { type: Date, required: true },
    admittedAt: Date,
    clinicalDischargedAt: Date,
    departedAt: Date,
    status: {
      type: String,
      enum: [
        'REQUESTED',
        'ADMITTED',
        'DISCHARGE_PLANNED',
        'CLINICALLY_DISCHARGED',
        'DEPARTED',
        'CANCELLED',
      ],
      default: 'REQUESTED',
    },
    financialStatus: { type: String, enum: ['OPEN', 'AWAITING_PAYER', 'CLOSED'], default: 'OPEN' },
    disposition: text(200),
    cancelReason: text(1000),
  },
  aggregateOptions,
);
admissionSchema.index({ organizationId: 1, admissionNumber: 1 }, { unique: true });
admissionSchema.index({ organizationId: 1, visitId: 1 }, { unique: true });
admissionSchema.index({ organizationId: 1, facilityId: 1, status: 1 });
admissionSchema.index({ organizationId: 1, patientId: 1, requestedAt: -1 });
export const Admission = model('Admission', admissionSchema, 'admissions');

/** Occupancy authority: one active assignment per bed and per admission, enforced by the database. */
const bedAssignmentSchema = new Schema(
  {
    ...metadataFields,
    ...custody,
    admissionId: ref('Admission'),
    bedId: ref('FacilityLocation'),
    startedAt: { type: Date, required: true },
    endedAt: Date,
    active: { type: Boolean, required: true },
    transferFromId: ref('BedAssignment', false),
    reason: text(1000, true),
  },
  aggregateOptions,
);
bedAssignmentSchema.index(
  { organizationId: 1, bedId: 1 },
  { unique: true, partialFilterExpression: { active: true } },
);
bedAssignmentSchema.index(
  { organizationId: 1, admissionId: 1 },
  { unique: true, partialFilterExpression: { active: true } },
);
bedAssignmentSchema.index({ admissionId: 1, startedAt: 1 });
export const BedAssignment = model('BedAssignment', bedAssignmentSchema, 'bedAssignments');

const administrationSchema = new Schema(
  {
    ...custody,
    admissionId: ref('Admission'),
    prescriptionItemId: ref('PrescriptionItem'),
    scheduledAt: Date,
    administeredAt: Date,
    doseValue: Schema.Types.Decimal128,
    doseUnit: text(40),
    route: text(60),
    performerId: ref('Practitioner'),
    checkerId: ref('Practitioner', false),
    status: {
      type: String,
      enum: ['GIVEN', 'NOT_GIVEN', 'REFUSED', 'HELD', 'ENTERED_IN_ERROR'],
      required: true,
    },
    reason: text(1000),
    correctsId: ref('MedicationAdministration', false),
    operationKey: text(200, true),
    recordedAt: { type: Date, required: true },
    recordedBy: { type: actorSchema, required: true },
    schemaVersion: { type: Number, default: 1 },
  },
  appendOnly,
);
administrationSchema.index({ organizationId: 1, operationKey: 1 }, { unique: true });
administrationSchema.index({ organizationId: 1, admissionId: 1, scheduledAt: 1 });
sealed(administrationSchema, 'Medication administration');
export const MedicationAdministration = model(
  'MedicationAdministration',
  administrationSchema,
  'medicationAdministrations',
);

const fluidSchema = new Schema(
  {
    ...custody,
    admissionId: ref('Admission'),
    direction: { type: String, enum: ['INTAKE', 'OUTPUT'], required: true },
    type: text(100, true),
    amountMl: { type: Number, required: true, min: 0, max: 20_000 },
    measuredAt: { type: Date, required: true },
    recordedByPractitionerId: ref('Practitioner'),
    correctsId: ref('FluidBalanceEntry', false),
    recordedBy: { type: actorSchema, required: true },
    createdAt: { type: Date, default: Date.now },
    schemaVersion: { type: Number, default: 1 },
  },
  appendOnly,
);
fluidSchema.index({ organizationId: 1, admissionId: 1, measuredAt: 1 });
sealed(fluidSchema, 'Fluid balance');
export const FluidBalanceEntry = model('FluidBalanceEntry', fluidSchema, 'fluidBalanceEntries');

const dischargePlanSchema = new Schema(
  {
    ...metadataFields,
    ...custody,
    admissionId: ref('Admission'),
    plannedAt: { type: Date, required: true },
    responsiblePractitionerId: ref('Practitioner'),
    summaryNoteId: ref('ClinicalNote', false),
    prescriptionId: ref('Prescription', false),
    checklist: {
      type: [
        new Schema(
          {
            code: text(60, true),
            label: text(200, true),
            required: { type: Boolean, required: true },
            status: { type: String, enum: ['PENDING', 'DONE', 'WAIVED'], default: 'PENDING' },
            by: actorSchema,
            at: Date,
            reason: text(1000),
          },
          value,
        ),
      ],
      validate: bounded(50),
    },
    status: { type: String, enum: ['DRAFT', 'READY', 'COMPLETED', 'CANCELLED'], default: 'DRAFT' },
  },
  aggregateOptions,
);
dischargePlanSchema.index({ organizationId: 1, admissionId: 1 }, { unique: true });
dischargePlanSchema.index({ status: 1, plannedAt: 1 });
export const DischargePlan = model('DischargePlan', dischargePlanSchema, 'dischargePlans');
