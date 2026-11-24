import { z } from 'zod';
import { objectId, version } from '../../shared/domain/healthcare.js';
import { ASSIGNABLE_ROLES } from './access.constants.js';

export const inviteInput = z
  .strictObject({
    userId: objectId,
    role: z.enum(ASSIGNABLE_ROLES),
    facilityScope: z.enum(['ALL', 'SELECTED']),
    facilityIds: z.array(objectId).max(100).default([]),
  })
  .superRefine((v, ctx) => {
    if (
      (v.facilityScope === 'ALL' && v.facilityIds.length) ||
      (v.facilityScope === 'SELECTED' && !v.facilityIds.length)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['facilityIds'],
        message: 'Selected scope needs facilities; all-facility scope must omit them',
      });
    }
  });
export const membershipStateInput = z.strictObject({
  expectedVersion: version,
  status: z.enum(['ACTIVE', 'SUSPENDED', 'ENDED']),
  reason: z.string().trim().min(5).max(1000),
});
export const acceptInput = z.strictObject({ expectedVersion: version });
export const roleAssignmentInput = z.strictObject({
  role: z.enum(ASSIGNABLE_ROLES),
  validUntil: z.iso.datetime().optional(),
});
export const roleRevocationInput = z.strictObject({
  expectedVersion: version,
  reason: z.string().trim().min(5).max(1000),
});
