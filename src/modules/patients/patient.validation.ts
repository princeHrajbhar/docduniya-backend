import { z } from 'zod';
import {
  nameInput,
  dateOnly,
  addressesInput,
  contactsInput,
  label,
  objectId,
  version,
  paginationInput,
  todayInIndia,
} from '../../shared/domain/healthcare.js';

export const demographicsInput = z
  .strictObject({
    name: nameInput,
    birthDate: dateOnly.optional(),
    administrativeSex: z.enum(['FEMALE', 'MALE', 'OTHER', 'UNKNOWN']).default('UNKNOWN'),
    preferredLanguage: z.string().trim().min(2).max(35).default('en'),
    addresses: addressesInput,
    contacts: contactsInput,
    emergencyContacts: z
      .array(
        z.strictObject({
          name: nameInput,
          relation: label,
          phone: z.string().regex(/^\+[1-9]\d{7,14}$/),
        }),
      )
      .max(5)
      .default([]),
  })
  .refine((v) => !v.birthDate || v.birthDate <= todayInIndia(), {
    path: ['birthDate'],
    message: 'Birth date cannot be in the future',
  });
export const createPatientInput = z
  .strictObject({
    profile: demographicsInput,
    kind: z.enum(['SELF', 'DEPENDENT']),
    relationship: z.enum(['PARENT', 'GUARDIAN', 'CAREGIVER', 'REPRESENTATIVE']).optional(),
    authorityReference: z.string().trim().min(5).max(500).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'DEPENDENT' && (!v.relationship || !v.authorityReference))
      ctx.addIssue({
        code: 'custom',
        message: 'Dependent requests require the relationship and authority evidence reference',
      });
    if (v.kind === 'SELF' && (v.relationship || v.authorityReference))
      ctx.addIssue({
        code: 'custom',
        message: 'Self profiles must not include representative authority',
      });
  });
export const updatePatientInput = z.strictObject({
  expectedVersion: version,
  profile: demographicsInput,
});
export const relationshipDecisionInput = z
  .strictObject({
    expectedVersion: version,
    decision: z.enum(['ACTIVE', 'REJECTED']),
    reason: z.string().trim().min(20).max(1000),
    validUntil: z.iso.datetime().optional(),
    medicalActions: z
      .array(z.enum(['medical.read', 'medical.upload', 'medical.export', 'consent.manage']))
      .max(4)
      .optional(),
    medicalAuthorityReference: z.string().trim().min(10).max(500).optional(),
  })
  .refine(
    (v) =>
      !v.medicalActions?.length ||
      (v.decision === 'ACTIVE' && Boolean(v.medicalAuthorityReference) && Boolean(v.validUntil)),
    'Medical representative authority needs explicit evidence and an expiry',
  );
export const registrationInput = z.strictObject({
  facilityId: objectId,
  profile: demographicsInput,
});
export const registrationQuery = paginationInput.extend({
  mrn: z
    .string()
    .regex(/^MRN-\d{8,16}$/)
    .optional(),
});
export const updateRegistrationInput = z.strictObject({
  expectedVersion: version,
  profile: demographicsInput,
  reason: z.string().trim().min(5).max(1000),
});
export const selfRegistrationInput = z.strictObject({
  organizationId: objectId,
  facilityId: objectId,
});
export const revokeRelationshipInput = z.strictObject({
  expectedVersion: version,
  reason: z.string().trim().min(5).max(1000),
});
