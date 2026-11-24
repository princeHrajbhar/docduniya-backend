import { z } from 'zod';
import {
  nameInput,
  contactsInput,
  addressesInput,
  languagesInput,
  dateOnly,
  label,
  addressInput,
  assertDateRange,
  objectId,
  version,
  todayInIndia,
} from '../../shared/domain/healthcare.js';

export const practitionerInput = z
  .strictObject({
    name: nameInput,
    profession: z.enum(['DOCTOR', 'NURSE', 'PHARMACIST', 'THERAPIST', 'LAB_PROFESSIONAL', 'OTHER']),
    birthDate: dateOnly.optional(),
    contacts: contactsInput,
    residentialAddresses: addressesInput,
    languages: languagesInput,
  })
  .refine((v) => !v.birthDate || v.birthDate <= todayInIndia(), {
    path: ['birthDate'],
    message: 'Birth date cannot be in the future',
  });
export const doctorInput = z.strictObject({
  slug: z
    .string()
    .min(3)
    .max(100)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  publicName: label,
  bio: z.string().trim().min(10).max(4000),
  specialtyIds: z.array(objectId).max(30).default([]),
  careerStartDate: dateOnly.optional(),
});
const evidenceReference = z.string().trim().min(5).max(500);
export const updatePractitionerInput = z.strictObject({
  expectedVersion: version,
  profile: practitionerInput,
});
export const updateDoctorInput = z.strictObject({ expectedVersion: version, profile: doctorInput });
export const qualificationInput = z
  .strictObject({
    kind: z.enum(['DEGREE', 'DIPLOMA', 'FELLOWSHIP', 'CERTIFICATION', 'TRAINING']),
    qualificationName: label,
    institutionName: label,
    institutionAddress: addressInput.optional(),
    startDate: dateOnly.optional(),
    completionDate: dateOnly.optional(),
    awardYear: z.number().int().min(1900).max(new Date().getUTCFullYear()).optional(),
    certificateNumber: label.optional(),
    evidenceReference,
  })
  .refine((v) => !v.startDate || assertDateRange(v.startDate, v.completionDate), {
    path: ['completionDate'],
    message: 'Completion must not precede start',
  });
export const employmentInput = z
  .strictObject({
    employerName: label,
    employerAddress: addressInput.optional(),
    title: label,
    department: label,
    startDate: dateOnly,
    endDate: dateOnly.optional(),
    employmentType: z.enum(['FULL_TIME', 'PART_TIME', 'VISITING', 'RESIDENCY', 'INTERNSHIP']),
    description: z.string().trim().max(4000).optional(),
    evidenceReference: evidenceReference.optional(),
  })
  .refine((v) => assertDateRange(v.startDate, v.endDate), {
    path: ['endDate'],
    message: 'End must not precede start',
  });
export const professionalRegistrationInput = z
  .strictObject({
    authority: label.transform((v) => v.toUpperCase()),
    jurisdiction: z
      .string()
      .trim()
      .min(2)
      .max(100)
      .transform((v) => v.toUpperCase()),
    registrationNumberNormalized: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .transform((v) => v.toUpperCase()),
    issuedOn: dateOnly.optional(),
    expiresOn: dateOnly.optional(),
    evidenceReference,
  })
  .refine((v) => !v.issuedOn || assertDateRange(v.issuedOn, v.expiresOn), {
    path: ['expiresOn'],
    message: 'Expiry must not precede issue',
  });
