import { z } from 'zod';
import { objectId, paginationInput, version } from '../../shared/domain/healthcare.js';
import { conceptInput, observationInput } from '../clinical/clinical.validation.js';

const reason = z.string().trim().min(5).max(1000);
const decimal = z.string().regex(/^\d{1,6}(\.\d{1,4})?$/);

export const admissionInput = z.strictObject({
  patientId: objectId,
  facilityId: objectId,
  type: z.enum(['ELECTIVE', 'EMERGENCY', 'TRANSFER']),
  reason: conceptInput,
});
export const admitInput = z.strictObject({
  expectedVersion: version,
  bedId: objectId,
  reason: reason.default('Initial bed assignment'),
});
export const transferInput = z.strictObject({
  expectedVersion: version,
  targetBedId: objectId,
  reason,
});
export const cancelAdmissionInput = z.strictObject({ expectedVersion: version, reason });
export const administrationInput = z
  .strictObject({
    prescriptionItemId: objectId,
    scheduledAt: z.iso.datetime().optional(),
    status: z.enum(['GIVEN', 'NOT_GIVEN', 'REFUSED', 'HELD']),
    administeredAt: z.iso.datetime().optional(),
    doseValue: decimal.optional(),
    doseUnit: z.string().trim().min(1).max(40).optional(),
    route: z.string().trim().min(1).max(60).optional(),
    checkerUserId: objectId.optional(),
    reason: reason.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.status === 'GIVEN' && (!v.administeredAt || !v.doseValue || !v.doseUnit || !v.route))
      ctx.addIssue({
        code: 'custom',
        message: 'A given dose needs its actual time, dose, unit and route',
      });
    if (v.status !== 'GIVEN' && !v.reason)
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'Explain why the dose was not given',
      });
  });
export const administrationCorrectionInput = z.strictObject({ reason });
export const fluidInput = z.strictObject({
  direction: z.enum(['INTAKE', 'OUTPUT']),
  type: z.string().trim().min(1).max(100),
  amountMl: z.number().int().min(0).max(20_000),
  measuredAt: z.iso.datetime(),
  correctsId: objectId.optional(),
});
export const inpatientObservationInput = observationInput;
export const dischargePlanInput = z.strictObject({
  plannedAt: z.iso.datetime(),
  checklist: z
    .array(
      z.strictObject({
        code: z.string().regex(/^[A-Z_]{2,60}$/),
        label: z.string().trim().min(1).max(200),
        required: z.boolean(),
      }),
    )
    .max(40)
    .default([]),
});
export const checklistUpdateInput = z.strictObject({
  expectedVersion: version,
  code: z.string().regex(/^[A-Z_]{2,60}$/),
  status: z.enum(['DONE', 'WAIVED']),
  reason: reason.optional(),
  summaryNoteId: objectId.optional(),
  prescriptionId: objectId.optional(),
});
export const dischargeInput = z.strictObject({
  expectedVersion: version,
  disposition: z.string().trim().min(2).max(200),
});
export const departInput = z.strictObject({ expectedVersion: version });
export const censusQuery = paginationInput.extend({
  facilityId: objectId,
  status: z
    .enum(['REQUESTED', 'ADMITTED', 'DISCHARGE_PLANNED', 'CLINICALLY_DISCHARGED'])
    .optional(),
});
export const bedBoardQuery = z.strictObject({ facilityId: objectId });
