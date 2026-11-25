import { z } from 'zod';
import { label, objectId, paginationInput, version } from '../../shared/domain/healthcare.js';
import { SIGNABLE } from './clinical.model.js';

const reason = z.string().trim().min(5).max(1000);
const longText = (max: number) => z.string().trim().min(1).max(max);
const decimal = z.string().regex(/^-?\d{1,9}(\.\d{1,6})?$/, 'Use a decimal string such as "98.6"');
export const conceptInput = z.strictObject({
  text: longText(500),
  codings: z
    .array(
      z.strictObject({
        system: longText(200),
        code: longText(100),
        display: longText(200),
        version: z.string().trim().max(60).optional(),
      }),
    )
    .max(5)
    .default([]),
});

export const encounterInput = z
  .strictObject({
    patientId: objectId,
    facilityId: objectId,
    visitId: objectId.optional(),
    visitType: z.enum(['OUTPATIENT', 'EMERGENCY', 'TELEHEALTH']).optional(),
    appointmentId: objectId.optional(),
    queueEntryId: objectId.optional(),
    type: conceptInput,
    mode: z.enum(['IN_PERSON', 'VIDEO', 'AUDIO']).default('IN_PERSON'),
    chiefComplaint: longText(2000),
    telemedicineConsentId: objectId.optional(),
  })
  .refine((v) => v.mode === 'IN_PERSON' || v.telemedicineConsentId, {
    path: ['telemedicineConsentId'],
    message: 'Remote consultations need the patient’s recorded telemedicine consent',
  });
export const expectedVersionInput = z.strictObject({ expectedVersion: version });
export const careTeamInput = z.strictObject({
  userId: objectId,
  roleCode: z.enum(['ATTENDING', 'CONSULTING', 'NURSING', 'ALLIED']),
  visitId: objectId.optional(),
});
export const endCareInput = z.strictObject({ expectedVersion: version, reason });

const source = z.enum(['PATIENT', 'CLINICIAN']).default('CLINICIAN');
export const allergyInput = z.strictObject({
  encounterId: objectId.optional(),
  source,
  substance: conceptInput,
  category: z.enum(['DRUG', 'FOOD', 'ENVIRONMENT', 'OTHER']),
  clinicalStatus: z.enum(['ACTIVE', 'INACTIVE', 'RESOLVED']),
  verificationStatus: z.enum(['UNCONFIRMED', 'CONFIRMED', 'REFUTED']),
  criticality: z.enum(['LOW', 'HIGH', 'UNABLE_TO_ASSESS']),
  reactions: z
    .array(
      z.strictObject({
        manifestation: conceptInput,
        severity: z.enum(['MILD', 'MODERATE', 'SEVERE']).optional(),
      }),
    )
    .max(20)
    .default([]),
  onset: z.iso.datetime().optional(),
  note: longText(2000).optional(),
});
export const conditionInput = z.strictObject({
  encounterId: objectId.optional(),
  source,
  code: conceptInput,
  clinicalStatus: z.enum(['ACTIVE', 'RECURRENCE', 'REMISSION', 'RESOLVED', 'INACTIVE']),
  verificationStatus: z.enum(['PROVISIONAL', 'DIFFERENTIAL', 'CONFIRMED', 'REFUTED']),
  onset: z.iso.datetime().optional(),
  abatement: z.iso.datetime().optional(),
  severity: z.enum(['MILD', 'MODERATE', 'SEVERE']).optional(),
  note: longText(2000).optional(),
});
export const medicationStatementInput = z.strictObject({
  encounterId: objectId.optional(),
  source,
  medication: conceptInput,
  drugId: objectId.optional(),
  status: z.enum(['ACTIVE', 'STOPPED', 'COMPLETED', 'UNKNOWN', 'NOT_TAKEN']),
  dosageText: longText(1000).optional(),
  periodStart: z.iso.datetime().optional(),
  periodEnd: z.iso.datetime().optional(),
});
export const immunizationInput = z
  .strictObject({
    encounterId: objectId.optional(),
    source,
    vaccine: conceptInput,
    status: z.enum(['COMPLETED', 'NOT_DONE']),
    occurrenceAt: z.iso.datetime(),
    doseText: longText(100).optional(),
    lotNumber: longText(60).optional(),
    route: longText(60).optional(),
    site: longText(60).optional(),
    primarySource: z.boolean(),
    reasonNotDone: longText(1000).optional(),
  })
  .refine((v) => v.status !== 'NOT_DONE' || v.reasonNotDone, {
    path: ['reasonNotDone'],
    message: 'Explain why it was not given',
  });
export const factUpdateInput = <T extends z.ZodRawShape>(shape: z.ZodObject<T>) =>
  z.strictObject({ expectedVersion: version, reason, record: shape });

export const observationValue = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('QUANTITY'), value: decimal, unit: longText(40) }),
  z.strictObject({ type: z.literal('TEXT'), text: longText(4000) }),
  z.strictObject({ type: z.literal('CODE'), code: conceptInput }),
  z.strictObject({ type: z.literal('BOOLEAN'), value: z.boolean() }),
]);
export const observationInput = z.strictObject({
  category: z.enum(['VITAL_SIGNS', 'EXAM', 'SOCIAL']),
  code: conceptInput,
  value: observationValue,
  effectiveAt: z.iso.datetime(),
  status: z.enum(['PRELIMINARY', 'FINAL']).default('FINAL'),
  referenceRange: z
    .strictObject({
      low: decimal.optional(),
      high: decimal.optional(),
      unit: longText(40).optional(),
      text: longText(200).optional(),
    })
    .optional(),
  interpretation: z
    .enum(['NORMAL', 'LOW', 'HIGH', 'CRITICAL_LOW', 'CRITICAL_HIGH', 'ABNORMAL'])
    .optional(),
});
const sections = z
  .strictObject({
    history: longText(32_000).optional(),
    examination: longText(32_000).optional(),
    assessment: longText(32_000).optional(),
    plan: longText(32_000).optional(),
  })
  .refine((v) => Object.values(v).some(Boolean), 'Write at least one section');
const reviewState = z
  .strictObject({
    allergies: z.enum(['UNKNOWN', 'REVIEWED', 'NONE_KNOWN']).default('UNKNOWN'),
    medications: z.enum(['UNKNOWN', 'REVIEWED', 'NONE_KNOWN']).default('UNKNOWN'),
  })
  .default({ allergies: 'UNKNOWN', medications: 'UNKNOWN' });
export const noteInput = z.strictObject({
  noteType: z.enum(['CONSULTATION', 'PROGRESS', 'DISCHARGE_SUMMARY', 'NURSING', 'PROCEDURE']),
  sections,
  reviewState,
});
export const noteUpdateInput = z.strictObject({ expectedVersion: version, sections, reviewState });
export const addendumInput = z.strictObject({ sections, reason });
export const diagnosisInput = z.strictObject({
  conditionId: objectId.optional(),
  code: conceptInput,
  rank: z.number().int().min(1).max(50),
  use: z.enum(['PRIMARY', 'SECONDARY', 'ADMISSION', 'DISCHARGE']),
  certainty: z.enum(['PROVISIONAL', 'DIFFERENTIAL', 'CONFIRMED', 'REFUTED']),
});
export const doseInput = z
  .strictObject({
    doseValue: decimal.optional(),
    doseUnit: longText(40).optional(),
    route: longText(60),
    frequencyPerDay: z.number().int().min(0).max(48).optional(),
    timesOfDay: z
      .array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/))
      .max(12)
      .default([]),
    asNeeded: z.boolean().default(false),
    asNeededReason: longText(200).optional(),
    durationDays: z.number().int().min(1).max(3650).optional(),
    instructions: longText(1000),
  })
  .refine((v) => !v.doseValue || v.doseUnit, { path: ['doseUnit'], message: 'A dose needs a unit' })
  .refine((v) => !v.asNeeded || v.asNeededReason, {
    path: ['asNeededReason'],
    message: 'State when to take it',
  });
export const prescriptionItemInput = z.strictObject({
  drugId: objectId.optional(),
  medication: z.strictObject({
    name: label,
    form: longText(100),
    strength: longText(100).optional(),
  }),
  dosage: z.array(doseInput).min(1).max(10),
  quantity: z.strictObject({ value: z.number().int().min(1).max(100_000), unit: longText(40) }),
  refillsAllowed: z.number().int().min(0).max(12).default(0),
  substitutionAllowed: z.boolean().default(true),
  instructions: longText(1000).optional(),
});
export const prescriptionInput = z.strictObject({
  items: z.array(prescriptionItemInput).min(1).max(100),
  validDays: z.number().int().min(1).max(180).default(30),
});
export const signInput = z.strictObject({
  expectedVersion: version,
  attestation: z.literal(true, 'Confirm that you reviewed and attest to this record'),
});
export const amendInput = z.strictObject({
  expectedVersion: version,
  reason,
  sections,
  reviewState,
});
export const markErrorInput = z.strictObject({ expectedVersion: version, reason });
export const stopItemInput = z.strictObject({ expectedVersion: version, reason });
export const signableType = z.enum(SIGNABLE);
export const taskInput = z.strictObject({
  patientId: objectId,
  kind: z.enum(['FOLLOW_UP', 'RESULT_REVIEW', 'REFERRAL', 'NURSING', 'OTHER']),
  title: label,
  dueAt: z.iso.datetime(),
  priority: z.enum(['ROUTINE', 'URGENT']),
  assigneeUserId: objectId.optional(),
  sourceRef: z.strictObject({
    type: z.enum(['encounter', 'clinicalNote', 'diagnosticReport', 'admission', 'prescription']),
    id: objectId,
  }),
});
export const taskTransitionInput = z.strictObject({
  expectedVersion: version,
  action: z.enum(['acknowledge', 'start', 'complete', 'cancel']),
  outcome: longText(2000).optional(),
});
export const taskQuery = paginationInput.extend({
  status: z.enum(['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'DONE', 'CANCELLED']).optional(),
  mine: z.enum(['true', 'false']).default('true'),
});
export const referralInput = z
  .strictObject({
    toOrganizationId: objectId.optional(),
    toSpecialtyId: objectId.optional(),
    reason: conceptInput,
    priority: z.enum(['ROUTINE', 'URGENT']),
    note: longText(4000).optional(),
  })
  .refine((v) => v.toOrganizationId || v.toSpecialtyId, 'Choose a provider or specialty');
export const referralResponseInput = z.strictObject({
  expectedVersion: version,
  decision: z.enum(['ACCEPT', 'DECLINE', 'COMPLETE']),
  reason,
});
export const encounterQuery = paginationInput.extend({ patientId: objectId.optional() });
export const sharedRecordsQuery = z.strictObject({
  resourceType: z.enum([
    'encounters',
    'clinicalNotes',
    'diagnoses',
    'observations',
    'allergies',
    'conditions',
    'medicationStatements',
    'prescriptions',
    'diagnosticReports',
    'immunizations',
  ]),
});
