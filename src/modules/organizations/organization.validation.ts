import { z } from 'zod';
import {
  addressInput,
  contactsInput,
  label,
  objectId,
  version,
} from '../../shared/domain/healthcare.js';

export const organizationParams = z.strictObject({ organizationId: objectId });
export const organizationInput = z.strictObject({
  kind: z.enum(['HOSPITAL', 'CLINIC', 'SOLO_PRACTICE', 'LAB', 'PHARMACY']),
  legalName: label,
  displayName: label,
  slug: z
    .string()
    .min(3)
    .max(100)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  legalAddress: addressInput,
  contacts: contactsInput,
});
export const facilityInput = z
  .strictObject({
    name: label,
    code: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[A-Z0-9_-]+$/),
    kind: z.enum(['HOSPITAL_BRANCH', 'CLINIC', 'VIRTUAL', 'LAB', 'PHARMACY']),
    address: addressInput.optional(),
    timezone: z.literal('Asia/Kolkata').default('Asia/Kolkata'),
    publicContacts: contactsInput,
  })
  .refine((v) => v.kind === 'VIRTUAL' || !!v.address, {
    path: ['address'],
    message: 'Physical facilities require an address',
  });
export const facilityStateInput = z.strictObject({
  expectedVersion: version,
  status: z.enum(['ACTIVE', 'INACTIVE']),
  reason: z.string().trim().min(5).max(1000),
});
export const updateOrganizationInput = z.strictObject({
  expectedVersion: version,
  profile: organizationInput,
});
export const updateFacilityInput = z.strictObject({
  expectedVersion: version,
  profile: facilityInput,
});
export const submitVerificationInput = z.strictObject({
  expectedVersion: version,
  declaration: z.string().trim().min(20).max(4000),
  evidenceReferences: z.array(z.string().trim().min(5).max(500)).min(1).max(20),
});
export const verificationDecisionInput = z.strictObject({
  expectedVersion: version,
  decision: z.enum(['APPROVED', 'REJECTED', 'CHANGES_REQUIRED']),
  reason: z.string().trim().min(20).max(4000),
});
export type OrganizationInput = z.infer<typeof organizationInput>;
export type FacilityInput = z.infer<typeof facilityInput>;
