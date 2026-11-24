import { z } from 'zod';
import { label, objectId, paginationInput, version } from '../../shared/domain/healthcare.js';
import { DOCUMENT_TYPES, LINK_TARGETS } from './document.model.js';

export const uploadIntentInput = z
  .strictObject({
    custody: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('PATIENT'), patientId: objectId }),
      z.strictObject({
        kind: z.literal('ORGANIZATION'),
        organizationId: objectId,
        patientId: objectId,
      }),
      z.strictObject({ kind: z.literal('USER') }),
    ]),
    category: z.enum([
      'CLINICAL_REPORT',
      'PRESCRIPTION',
      'CREDENTIAL',
      'IDENTITY',
      'CONSENT',
      'OTHER',
    ]),
    title: label,
    originalName: z
      .string()
      .trim()
      .min(1)
      .max(200)
      // eslint-disable-next-line no-control-regex -- control characters are exactly what is rejected
      .regex(/^[^\\/:*?"<>|\u0000-\u001f]+$/, 'Use a plain file name'),
    mimeType: z.enum(DOCUMENT_TYPES),
    sizeBytes: z.number().int().min(1),
  })
  .refine((v) => v.custody.kind !== 'USER' || ['CREDENTIAL', 'IDENTITY'].includes(v.category), {
    path: ['category'],
    message: 'Personal custody is for credential and identity evidence',
  });
export const completeUploadInput = z.strictObject({ expectedVersion: version });
export const accessInput = z.strictObject({
  purpose: z.enum(['TREATMENT', 'PATIENT_ACCESS', 'CREDENTIAL_REVIEW', 'BILLING', 'LEGAL']),
});
export const linkInput = z.strictObject({
  target: z.strictObject({ type: z.enum(LINK_TARGETS), id: objectId }),
  relationship: z.enum(['EVIDENCE', 'REPORT', 'ATTACHMENT']),
});
export const releaseInput = z.strictObject({ expectedVersion: version });
export const documentQuery = paginationInput.extend({
  patientId: objectId.optional(),
});
