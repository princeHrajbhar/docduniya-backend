import { describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import {
  createPatientInput,
  demographicsInput,
} from '../src/modules/patients/patient.validation.js';
import {
  doctorInput,
  employmentInput,
  professionalRegistrationInput,
} from '../src/modules/practitioners/practitioner.validation.js';
import {
  facilityInput,
  organizationInput,
} from '../src/modules/organizations/organization.validation.js';
import { inviteInput } from '../src/modules/access/membership.validation.js';
import { contactInput, paginationInput } from '../src/shared/domain/healthcare.js';
import { Patient } from '../src/modules/patients/patient.model.js';
import { stamp } from '../src/shared/persistence/schema.js';

const address = {
  use: 'WORK',
  line1: 'Example Road',
  city: 'Kolkata',
  stateCode: 'WB',
  postalCode: '700001',
};

describe('Healthcare request boundaries', () => {
  it('rejects client-controlled patient ownership and privilege fields', () => {
    expect(
      createPatientInput.safeParse({
        kind: 'SELF',
        ownerUserId: String(new Types.ObjectId()),
        profile: { name: { display: 'Example' } },
      }).success,
    ).toBe(false);
    expect(
      doctorInput.safeParse({
        slug: 'example-doctor',
        publicName: 'Example',
        bio: 'A professional biography',
        verificationStatus: 'VERIFIED',
        profilePublished: true,
      }).success,
    ).toBe(false);
    expect(
      organizationInput.safeParse({
        kind: 'CLINIC',
        legalName: 'Example',
        displayName: 'Example',
        slug: 'example-clinic',
        legalAddress: address,
        status: 'ACTIVE',
      }).success,
    ).toBe(false);
  });

  it('requires representative evidence without treating a dependent request as consent', () => {
    expect(
      createPatientInput.safeParse({ kind: 'DEPENDENT', profile: { name: { display: 'Example' } } })
        .success,
    ).toBe(false);
    expect(
      createPatientInput.safeParse({
        kind: 'SELF',
        relationship: 'GUARDIAN',
        authorityReference: 'manual-case-123',
        profile: { name: { display: 'Example' } },
      }).success,
    ).toBe(false);
  });

  it('validates real calendar dates and future birth dates', () => {
    for (const birthDate of ['2025-02-29', '2001-13-01', '2999-01-01']) {
      expect(demographicsInput.safeParse({ name: { display: 'Example' }, birthDate }).success).toBe(
        false,
      );
    }
    expect(
      demographicsInput.parse({ name: { display: 'Example' }, birthDate: '2000-02-29' }).birthDate,
    ).toBe('2000-02-29');
  });

  it('keeps contact normalization server-owned and validates phone numbers', () => {
    expect(
      contactInput.parse({ kind: 'EMAIL', value: 'Person@Example.com', use: 'WORK' }).normalized,
    ).toBe('person@example.com');
    expect(
      contactInput.safeParse({ kind: 'PHONE', value: '9876543210', use: 'PERSONAL' }).success,
    ).toBe(false);
    expect(
      contactInput.safeParse({
        kind: 'EMAIL',
        value: 'a@example.com',
        use: 'WORK',
        verifiedAt: '2026-01-01',
      }).success,
    ).toBe(false);
  });

  it('requires physical addresses and Indian PIN codes', () => {
    expect(facilityInput.safeParse({ name: 'Clinic', code: 'A', kind: 'CLINIC' }).success).toBe(
      false,
    );
    expect(
      facilityInput.safeParse({
        name: 'Clinic',
        code: 'A',
        kind: 'CLINIC',
        address: { ...address, postalCode: 'ABCDE' },
      }).success,
    ).toBe(false);
    expect(facilityInput.parse({ name: 'Virtual care', code: 'V', kind: 'VIRTUAL' }).timezone).toBe(
      'Asia/Kolkata',
    );
  });

  it('rejects contradictory facility grants and owner role assignment', () => {
    const userId = String(new Types.ObjectId());
    expect(
      inviteInput.safeParse({ userId, role: 'owner', facilityScope: 'ALL', facilityIds: [] })
        .success,
    ).toBe(false);
    expect(
      inviteInput.safeParse({
        userId,
        role: 'receptionist',
        facilityScope: 'SELECTED',
        facilityIds: [],
      }).success,
    ).toBe(false);
    expect(
      inviteInput.safeParse({
        userId,
        role: 'receptionist',
        facilityScope: 'ALL',
        facilityIds: [userId],
      }).success,
    ).toBe(false);
  });

  it('rejects reversed employment and registration validity ranges', () => {
    expect(
      employmentInput.safeParse({
        employerName: 'Example Hospital',
        title: 'Doctor',
        department: 'Medicine',
        startDate: '2025-01-01',
        endDate: '2024-12-31',
        employmentType: 'FULL_TIME',
      }).success,
    ).toBe(false);
    expect(
      professionalRegistrationInput.safeParse({
        authority: 'Test council',
        jurisdiction: 'WB',
        registrationNumberNormalized: '123',
        issuedOn: '2025-01-01',
        expiresOn: '2024-01-01',
        evidenceReference: 'manual-case-123',
      }).success,
    ).toBe(false);
  });

  it('caps enumeration and rejects operator-shaped query parameters', () => {
    expect(paginationInput.safeParse({ limit: '101' }).success).toBe(false);
    expect(paginationInput.safeParse({ before: { $gt: '' } }).success).toBe(false);
    expect(
      paginationInput.safeParse({ organizationId: String(new Types.ObjectId()) }).success,
    ).toBe(false);
  });
});

describe('Persistence defenses independent of HTTP validation', () => {
  it('accepts an Indian newborn date after local midnight but before UTC midnight', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T20:00:00Z'));
    try {
      expect(
        demographicsInput.safeParse({
          name: { display: 'Synthetic newborn' },
          birthDate: '2026-01-02',
        }).success,
      ).toBe(true);
      expect(
        demographicsInput.safeParse({
          name: { display: 'Synthetic newborn' },
          birthDate: '2026-01-03',
        }).success,
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
  it('requires audit provenance and rejects unknown persisted fields', async () => {
    const dto = demographicsInput.parse({ name: { display: 'Example' } });
    await expect(new Patient({ ...dto, birthDatePrecision: 'UNKNOWN' }).validate()).rejects.toThrow(
      'createdBy',
    );
    expect(
      () =>
        new Patient({
          ...dto,
          ...stamp(String(new Types.ObjectId())),
          birthDatePrecision: 'UNKNOWN',
          unrestrictedAccess: true,
        }),
    ).toThrow();
  });

  it('bounds embedded data even when a writer bypasses the HTTP DTO', async () => {
    const dto = demographicsInput.parse({ name: { display: 'Example' } });
    const contact = contactInput.parse({
      kind: 'EMAIL',
      value: 'example@example.com',
      use: 'PERSONAL',
    });
    await expect(
      new Patient({
        ...dto,
        ...stamp(String(new Types.ObjectId())),
        birthDatePrecision: 'UNKNOWN',
        contacts: Array.from({ length: 11 }, () => contact),
      }).validate(),
    ).rejects.toThrow('At most 10');
  });
});
