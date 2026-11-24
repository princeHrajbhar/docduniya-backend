import { z } from 'zod';
import { objectId, version, paginationInput } from '../../shared/domain/healthcare.js';

const reason = z.string().trim().min(5).max(1000);

export const holdInput = z.strictObject({
  patientId: objectId,
  offeringId: objectId,
  offeringVersion: version,
  priceId: objectId,
  startAt: z.iso.datetime(),
  reasonForVisit: z.string().trim().min(1).max(1000).optional(),
});
export const appointmentCommandInput = z.strictObject({ expectedVersion: version });
export const cancelInput = z.strictObject({ expectedVersion: version, reason });
export const rescheduleInput = z.strictObject({
  expectedVersion: version,
  offeringId: objectId,
  offeringVersion: version,
  priceId: objectId,
  startAt: z.iso.datetime(),
  reason,
});
export const transitionInput = z.strictObject({
  expectedVersion: version,
  reason: reason.optional(),
});
export const appointmentQuery = paginationInput.extend({
  patientId: objectId.optional(),
  facilityId: objectId.optional(),
  date: z.iso.date().optional(),
  status: z
    .enum([
      'HELD',
      'CONFIRMED',
      'EXPIRED',
      'CANCELLED',
      'CHECKED_IN',
      'IN_PROGRESS',
      'COMPLETED',
      'DISCONTINUED',
      'NO_SHOW',
    ])
    .optional(),
  requiresReassignment: z.enum(['true', 'false']).optional(),
});
export const walkInInput = z.strictObject({
  facilityId: objectId,
  patientRegistrationId: objectId,
  priority: z.enum(['ROUTINE', 'URGENT', 'EMERGENCY']).default('ROUTINE'),
  priorityReason: reason.optional(),
});
export const queueTransitionInput = z.strictObject({
  expectedVersion: version,
  action: z.enum(['call', 'serve', 'done', 'left', 'prioritize']),
  priority: z.enum(['ROUTINE', 'URGENT', 'EMERGENCY']).optional(),
  reason: reason.optional(),
});
export const queueQuery = paginationInput.extend({
  facilityId: objectId,
  date: z.iso.date().optional(),
  status: z.enum(['WAITING', 'CALLED', 'IN_SERVICE', 'DONE', 'LEFT']).optional(),
});
