import { z } from 'zod';
import { label, objectId, version, paginationInput } from '../../shared/domain/healthcare.js';

export const verificationSubmission = z.strictObject({
  expectedVersion: version,
  registrationId: objectId,
  qualificationIds: z
    .array(objectId)
    .min(1)
    .max(20)
    .refine((v) => new Set(v).size === v.length, 'Choose distinct qualifications'),
  declaration: z.string().trim().min(20).max(4000),
});
export const verificationDecision = z
  .strictObject({
    expectedVersion: version,
    decision: z.enum(['APPROVED', 'REJECTED', 'CHANGES_REQUIRED']),
    reason: z.string().trim().min(20).max(4000),
    validUntil: z.iso.datetime().optional(),
    checks: z
      .strictObject({
        identityChecked: z.literal(true),
        registrationChecked: z.literal(true),
        qualificationsChecked: z.literal(true),
      })
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (v.decision === 'APPROVED' && (!v.validUntil || !v.checks))
      ctx.addIssue({
        code: 'custom',
        message: 'Approval requires an expiry and all independent review checks',
      });
    if (v.decision !== 'APPROVED' && (v.validUntil || v.checks))
      ctx.addIssue({ code: 'custom', message: 'Approval fields are only valid for approval' });
  });
export const withdrawVerificationInput = z.strictObject({
  expectedVersion: version,
  reason: z.string().trim().min(5).max(1000),
});
export const doctorRestrictionInput = z.strictObject({
  expectedVersion: version,
  status: z.enum(['SUSPENDED', 'UNVERIFIED']),
  reason: z.string().trim().min(20).max(1000),
});
export const publicationInput = z.strictObject({
  expectedVersion: version,
  published: z.boolean(),
});
export const affiliationInput = z
  .strictObject({
    doctorId: objectId,
    facilityId: objectId,
    title: label,
    department: label,
    validFrom: z.iso.datetime().optional(),
    validUntil: z.iso.datetime().optional(),
  })
  .refine((v) => !v.validFrom || !v.validUntil || new Date(v.validUntil) > new Date(v.validFrom), {
    path: ['validUntil'],
    message: 'End must follow start',
  });
export const affiliationResponse = z.strictObject({
  expectedVersion: version,
  decision: z.enum(['ACCEPT', 'REJECT']),
});
export const affiliationState = z.strictObject({
  expectedVersion: version,
  status: z.enum(['ACTIVE', 'SUSPENDED', 'ENDED']),
  reason: z.string().trim().min(5).max(1000),
});
export const ownAffiliationEnd = z.strictObject({
  expectedVersion: version,
  reason: z.string().trim().min(5).max(1000),
});
export const discoveryQuery = paginationInput.extend({
  limit: z.coerce.number().int().min(1).max(25).default(10),
  organizationId: objectId.optional(),
  facilityId: objectId.optional(),
  doctorId: objectId.optional(),
  specialtyId: objectId.optional(),
});
