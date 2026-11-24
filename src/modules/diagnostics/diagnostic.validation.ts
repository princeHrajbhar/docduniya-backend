import { z } from 'zod';
import { label, objectId, paginationInput, version } from '../../shared/domain/healthcare.js';
import { conceptInput, observationValue } from '../clinical/clinical.validation.js';

const reason = z.string().trim().min(5).max(1000);
const decimal = z.string().regex(/^-?\d{1,9}(\.\d{1,6})?$/);

export const testCatalogInput = z.strictObject({
  system: label,
  code: z.string().trim().min(1).max(100),
  release: z.string().trim().min(1).max(60),
  name: label,
  kind: z.enum(['LAB', 'PANEL', 'IMAGING']),
  analytes: z
    .array(z.strictObject({ code: conceptInput, unit: z.string().trim().max(40).optional() }))
    .max(200)
    .default([]),
  specimenRequirements: z
    .array(z.strictObject({ type: label, container: label }))
    .max(20)
    .default([]),
  preparationInstructions: z.string().trim().max(2000).optional(),
  licenseReference: label,
});
export const orderInput = z.strictObject({
  kind: z.enum(['LAB', 'IMAGING']),
  testCatalogId: objectId.optional(),
  code: conceptInput,
  performingFacilityId: objectId,
  priority: z.enum(['ROUTINE', 'URGENT', 'STAT']),
  reason: conceptInput,
  instructions: z.string().trim().max(2000).optional(),
});
export const orderTransitionInput = z.strictObject({
  expectedVersion: version,
  action: z.enum(['accept', 'cancel']),
  reason: reason.optional(),
});
export const specimenInput = z.strictObject({
  serviceOrderIds: z.array(objectId).min(1).max(30),
  type: label,
  container: label,
  parentSpecimenId: objectId.optional(),
});
export const specimenTransitionInput = z.strictObject({
  expectedVersion: version,
  action: z.enum(['receive', 'reject']),
  reason: reason.optional(),
});
export const resultInput = z.strictObject({
  serviceOrderId: objectId,
  specimenId: objectId.optional(),
  code: conceptInput,
  value: observationValue,
  effectiveAt: z.iso.datetime(),
  referenceRange: z
    .strictObject({
      low: decimal.optional(),
      high: decimal.optional(),
      unit: z.string().max(40).optional(),
      text: z.string().max(200).optional(),
    })
    .optional(),
  interpretation: z
    .enum(['NORMAL', 'LOW', 'HIGH', 'CRITICAL_LOW', 'CRITICAL_HIGH', 'ABNORMAL'])
    .optional(),
});
export const reportInput = z.strictObject({
  serviceOrderIds: z.array(objectId).min(1).max(30),
  code: conceptInput,
  results: z.array(resultInput).max(200).default([]),
  conclusion: z.string().trim().max(8000).optional(),
});
export const verifyReportInput = z.strictObject({
  expectedVersion: version,
  attestation: z.literal(true, 'Confirm that you verified these results'),
});
export const amendReportInput = z.strictObject({
  expectedVersion: version,
  reason,
  conclusion: z.string().trim().max(8000).optional(),
  corrections: z
    .array(
      z.strictObject({
        observationId: objectId,
        value: observationValue,
        interpretation: resultInput.shape.interpretation,
      }),
    )
    .max(200)
    .default([]),
});
export const imagingStudyInput = z.strictObject({
  serviceOrderId: objectId,
  studyInstanceUid: z.string().regex(/^[0-9.]{1,64}$/),
  modalityCodes: z
    .array(z.string().regex(/^[A-Z]{2,4}$/))
    .max(20)
    .default([]),
  startedAt: z.iso.datetime(),
  seriesCount: z.number().int().min(0).max(10_000).default(0),
  instanceCount: z.number().int().min(0).max(1_000_000).default(0),
  pacsReference: z.string().trim().min(1).max(500),
});
export const worklistQuery = paginationInput.extend({
  facilityId: objectId,
  status: z.enum(['PLACED', 'ACCEPTED', 'IN_PROGRESS']).optional(),
});
export const catalogQuery = paginationInput.extend({
  kind: z.enum(['LAB', 'PANEL', 'IMAGING']).optional(),
  q: z.string().trim().max(60).optional(),
});
