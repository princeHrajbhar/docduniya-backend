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
const text = (max: number, required = false) => ({ type: String, maxlength: max, required });
const custody = {
  organizationId: ref('Organization'),
  patientId: ref('Patient'),
  patientRegistrationId: ref('PatientRegistration'),
  encounterId: ref('Encounter', false),
};

/** Platform catalog of orderable tests. Reference ranges are laboratory specific, not global. */
const catalogSchema = new Schema(
  {
    ...metadataFields,
    system: text(200, true),
    code: text(100, true),
    release: text(60, true),
    name: text(200, true),
    kind: { type: String, enum: ['LAB', 'PANEL', 'IMAGING'], required: true },
    analytes: {
      type: [new Schema({ code: { type: conceptSchema, required: true }, unit: text(40) }, value)],
      default: [],
      validate: bounded(200),
    },
    specimenRequirements: {
      type: [new Schema({ type: text(100, true), container: text(100, true) }, value)],
      default: [],
      validate: bounded(20),
    },
    preparationInstructions: text(2000),
    licenseReference: text(200, true),
    status: { type: String, enum: ['ACTIVE', 'RETIRED'], default: 'ACTIVE' },
  },
  aggregateOptions,
);
catalogSchema.index({ system: 1, code: 1, release: 1 }, { unique: true });
catalogSchema.index({ kind: 1, status: 1, name: 1 });
export const DiagnosticTest = model('DiagnosticTest', catalogSchema, 'diagnosticTestCatalog');

const orderSchema = new Schema(
  {
    ...metadataFields,
    ...custody,
    provenance: {
      type: new Schema(
        {
          source: { type: String, enum: ['CLINICIAN'], required: true },
          recordedAt: { type: Date, required: true },
          recordedBy: { type: actorSchema, required: true },
        },
        value,
      ),
      required: true,
    },
    orderNumber: text(40, true),
    kind: { type: String, enum: ['LAB', 'IMAGING'], required: true },
    code: { type: conceptSchema, required: true },
    testCatalogId: ref('DiagnosticTest', false),
    requestedBy: ref('Practitioner'),
    performingFacilityId: ref('Facility'),
    requestedAt: { type: Date, required: true },
    priority: { type: String, enum: ['ROUTINE', 'URGENT', 'STAT'], required: true },
    reason: { type: conceptSchema, required: true },
    instructions: text(2000),
    status: {
      type: String,
      enum: ['PLACED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
      default: 'PLACED',
    },
    cancelReason: text(1000),
    currentRevisionId: ref('ClinicalRevision', false),
    revisionCount: { type: Number, default: 0 },
  },
  aggregateOptions,
);
orderSchema.index({ organizationId: 1, orderNumber: 1 }, { unique: true });
orderSchema.index({ organizationId: 1, patientId: 1, requestedAt: -1 });
orderSchema.index({ organizationId: 1, performingFacilityId: 1, status: 1, priority: 1 });
export const ServiceOrder = model('ServiceOrder', orderSchema, 'serviceOrders');

const specimenSchema = new Schema(
  {
    ...metadataFields,
    ...custody,
    serviceOrderIds: { type: [Schema.Types.ObjectId], required: true, validate: bounded(30) },
    accessionNumber: text(40, true),
    barcode: text(60, true),
    type: text(100, true),
    container: text(100, true),
    collectedAt: Date,
    collectedBy: ref('Practitioner', false),
    receivedAt: Date,
    receivedBy: ref('Practitioner', false),
    parentSpecimenId: ref('Specimen', false),
    status: {
      type: String,
      enum: ['COLLECTED', 'RECEIVED', 'REJECTED', 'DISPOSED'],
      default: 'COLLECTED',
    },
    rejectionReason: text(1000),
  },
  aggregateOptions,
);
specimenSchema.index({ organizationId: 1, accessionNumber: 1 }, { unique: true });
specimenSchema.index({ organizationId: 1, barcode: 1 }, { unique: true });
specimenSchema.index({ serviceOrderIds: 1 });
export const Specimen = model('Specimen', specimenSchema, 'specimens');

const reportSchema = new Schema(
  {
    ...metadataFields,
    ...custody,
    reportNumber: text(40, true),
    serviceOrderIds: { type: [Schema.Types.ObjectId], required: true, validate: bounded(30) },
    specimenIds: { type: [Schema.Types.ObjectId], default: [], validate: bounded(30) },
    code: { type: conceptSchema, required: true },
    resultIds: { type: [Schema.Types.ObjectId], default: [], validate: bounded(500) },
    conclusion: text(8000),
    performerOrganizationId: ref('Organization'),
    enteredBy: ref('Practitioner'),
    resultsInterpreterId: ref('Practitioner', false),
    issuedAt: Date,
    critical: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ['PRELIMINARY', 'FINAL', 'AMENDED', 'CANCELLED', 'ENTERED_IN_ERROR'],
      default: 'PRELIMINARY',
    },
    correctionReason: text(1000),
    documentId: ref('ClinicalDocument', false),
    currentRevisionId: ref('ClinicalRevision', false),
    revisionCount: { type: Number, default: 0 },
  },
  aggregateOptions,
);
reportSchema.index({ organizationId: 1, reportNumber: 1 }, { unique: true });
reportSchema.index({ organizationId: 1, patientId: 1, issuedAt: -1 });
reportSchema.index({ patientId: 1, status: 1 });
export const DiagnosticReport = model('DiagnosticReport', reportSchema, 'diagnosticReports');

/** Reference to a study held in a PACS. Source images are never stored or transformed here. */
const imagingSchema = new Schema(
  {
    ...metadataFields,
    ...custody,
    serviceOrderId: ref('ServiceOrder'),
    studyInstanceUid: { type: String, required: true, match: /^[0-9.]{1,64}$/ },
    accessionNumber: text(40, true),
    modalityCodes: { type: [String], default: [], validate: bounded(20) },
    startedAt: { type: Date, required: true },
    seriesCount: { type: Number, default: 0, min: 0 },
    instanceCount: { type: Number, default: 0, min: 0 },
    pacsReference: text(500, true),
    diagnosticReportId: ref('DiagnosticReport', false),
    status: {
      type: String,
      enum: ['REGISTERED', 'AVAILABLE', 'CANCELLED', 'ENTERED_IN_ERROR'],
      default: 'AVAILABLE',
    },
  },
  aggregateOptions,
);
imagingSchema.index({ organizationId: 1, studyInstanceUid: 1 }, { unique: true });
imagingSchema.index({ serviceOrderId: 1 });
export const ImagingStudy = model('ImagingStudy', imagingSchema, 'imagingStudies');
