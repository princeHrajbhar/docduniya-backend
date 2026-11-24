import { z } from 'zod';
import {
  objectId,
  label,
  version,
  dateOnly,
  paginationInput,
} from '../../shared/domain/healthcare.js';
import { minorUnits } from '../../shared/domain/money.js';
export const resourceInput = z.strictObject({
  facilityId: objectId,
  kind: z.enum(['ROOM', 'DEVICE']),
  name: label,
});
export const cancellationInput = z.strictObject({
  noticeHours: z.number().int().min(0).max(720).default(24),
  refundBeforeBps: z.number().int().min(0).max(10000).default(10000),
  refundAfterBps: z.number().int().min(0).max(10000).default(0),
});
export const offeringInput = z.strictObject({
  doctorAffiliationId: objectId,
  name: label,
  mode: z.enum(['IN_PERSON', 'VIDEO', 'AUDIO']),
  durationMinutes: z.number().int().min(5).max(240),
  bufferBeforeMinutes: z.number().int().min(0).max(120).default(0),
  bufferAfterMinutes: z.number().int().min(0).max(120).default(0),
  resourceIds: z
    .array(objectId)
    .max(10)
    .default([])
    .refine((v) => new Set(v).size === v.length, 'Choose distinct resources'),
  paymentPolicy: z.enum(['PAY_AT_PROVIDER', 'PREPAY', 'FREE']),
  cancellationPolicy: cancellationInput,
});
export const priceInput = z.strictObject({
  expectedVersion: version,
  amountMinor: minorUnits,
  taxBasisPoints: z.number().int().min(0).max(10000).default(0),
  currency: z.literal('INR').default('INR'),
});
export const offeringStateInput = z.strictObject({
  expectedVersion: version,
  status: z.enum(['ACTIVE', 'INACTIVE']),
  reason: z.string().trim().min(5).max(1000),
});
export const scheduleInput = z
  .strictObject({
    offeringId: objectId,
    weekdays: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .refine((v) => new Set(v).size === v.length),
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(1).max(1440),
    stepMinutes: z.number().int().min(5).max(240),
    effectiveFrom: dateOnly,
    effectiveUntil: dateOnly,
  })
  .refine(
    (v) => v.endMinute > v.startMinute && v.effectiveUntil >= v.effectiveFrom,
    'Schedule intervals must be ordered',
  );
export const scheduleStateInput = offeringStateInput;
export const availabilityQuery = z.strictObject({ date: dateOnly });
export const offeringQuery = paginationInput.extend({
  facilityId: objectId.optional(),
  doctorId: objectId.optional(),
});
export const blockInput = z
  .strictObject({
    startAt: z.iso.datetime(),
    endAt: z.iso.datetime(),
    reason: z.string().trim().min(5).max(1000),
  })
  .refine(
    (v) =>
      new Date(v.endAt) > new Date(v.startAt) &&
      new Date(v.endAt).getTime() - new Date(v.startAt).getTime() <= 90 * 86400_000,
    'Block must cover at most 90 days',
  );
