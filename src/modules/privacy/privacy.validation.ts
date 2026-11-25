import { z } from 'zod';
import { label, objectId, paginationInput, version } from '../../shared/domain/healthcare.js';
import { SHAREABLE_RESOURCES } from './privacy.model.js';

const reason = z.string().trim().min(5).max(1000);

export const policyInput = z.strictObject({
  kind: z.enum(['PRIVACY', 'TERMS', 'SHARING', 'TELEMEDICINE', 'RECORD_SHARING_CONSENT']),
  code: z.string().regex(/^[A-Z][A-Z0-9_]{2,59}$/),
  language: z
    .string()
    .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
    .default('en'),
  title: label,
  text: z.string().trim().min(20).max(50_000),
  effectiveFrom: z.iso.datetime(),
});
export const acknowledgementInput = z.strictObject({
  policyVersionId: objectId,
  patientId: objectId.optional(),
  channel: z.enum(['WEB', 'MOBILE', 'ASSISTED']).default('WEB'),
});
export const sharingConsentInput = z
  .strictObject({
    recipientOrganizationId: objectId,
    purposes: z
      .array(z.enum(['TREATMENT', 'SECOND_OPINION', 'CARE_COORDINATION']))
      .min(1)
      .max(3),
    resourceTypes: z.array(z.enum(SHAREABLE_RESOURCES)).min(1).max(SHAREABLE_RESOURCES.length),
    recordPeriodStart: z.iso.datetime().optional(),
    recordPeriodEnd: z.iso.datetime().optional(),
    expiresAt: z.iso.datetime(),
    policyVersionId: objectId.optional(),
  })
  .refine(
    (v) =>
      new Date(v.expiresAt) > new Date() &&
      new Date(v.expiresAt).getTime() - Date.now() <= 366 * 86400_000,
    {
      path: ['expiresAt'],
      message: 'Sharing must expire within one year',
    },
  )
  .refine((v) => new Set(v.resourceTypes).size === v.resourceTypes.length, {
    path: ['resourceTypes'],
    message: 'Choose each record type once',
  })
  .refine(
    (v) => !v.recordPeriodStart || !v.recordPeriodEnd || v.recordPeriodStart < v.recordPeriodEnd,
    'Record period must end after it starts',
  );
export const providerConsentInput = z
  .strictObject({
    patientId: objectId,
    kind: z.enum(['TELEMEDICINE', 'PROCEDURE']),
    procedureDescription: z.string().trim().min(5).max(2000).optional(),
    expiresAt: z.iso.datetime().optional(),
    evidenceStatement: z.string().trim().min(10).max(2000),
    policyVersionId: objectId.optional(),
  })
  .refine((v) => v.kind !== 'PROCEDURE' || v.procedureDescription, {
    path: ['procedureDescription'],
    message: 'Describe the procedure',
  });
export const withdrawInput = z.strictObject({ expectedVersion: version, reason });
export const emergencyAccessInput = z.strictObject({ reason: z.string().trim().min(20).max(1000) });
export const emergencyReviewInput = z.strictObject({
  expectedVersion: version,
  outcome: z.enum(['JUSTIFIED', 'UNJUSTIFIED']),
  note: reason,
});
export const privacyRequestInput = z.strictObject({
  kind: z.enum(['ACCESS', 'EXPORT', 'CORRECTION', 'ERASURE', 'GRIEVANCE']),
  organizationId: objectId.optional(),
  reason: z.string().trim().min(10).max(4000),
});
export const privacyDecisionInput = z.strictObject({
  expectedVersion: version,
  status: z.enum(['VERIFYING', 'IN_PROGRESS', 'COMPLETED', 'PARTIALLY_COMPLETED', 'REJECTED']),
  decisionReason: z.string().trim().min(5).max(4000),
});
export const retentionHoldInput = z
  .strictObject({ organizationId: objectId.optional(), patientId: objectId.optional(), reason })
  .refine(
    (v) => Boolean(v.organizationId) !== Boolean(v.patientId),
    'Hold exactly one organization or patient',
  );
export const auditQuery = paginationInput.extend({
  patientId: objectId.optional(),
  action: z
    .string()
    .regex(/^[A-Za-z.:-]{2,80}$/)
    .optional(),
});
export const consentQuery = paginationInput.extend({
  status: z.enum(['ACTIVE', 'WITHDRAWN', 'EXPIRED']).optional(),
});
