import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import {
  affiliationInput,
  discoveryQuery,
  verificationDecision,
  verificationSubmission,
} from '../src/modules/providers/provider.validation.js';

describe('Provider review input boundaries', () => {
  it('requires explicit independent-review attestations for approval', () => {
    const base = {
      expectedVersion: 0,
      decision: 'APPROVED',
      reason: 'Synthetic independent review record.',
      validUntil: '2027-01-01T00:00:00Z',
    };
    expect(verificationDecision.safeParse(base).success).toBe(false);
    expect(
      verificationDecision.safeParse({
        ...base,
        checks: { identityChecked: true, registrationChecked: false, qualificationsChecked: true },
      }).success,
    ).toBe(false);
    expect(
      verificationDecision.safeParse({
        ...base,
        checks: { identityChecked: true, registrationChecked: true, qualificationsChecked: true },
      }).success,
    ).toBe(true);
    expect(verificationDecision.safeParse({ ...base, decision: 'REJECTED' }).success).toBe(false);
  });
  it('rejects client-controlled review status and repeated evidence identifiers', () => {
    const id = String(new Types.ObjectId());
    const base = {
      expectedVersion: 0,
      registrationId: id,
      qualificationIds: [id],
      declaration: 'Synthetic credentials declaration.',
    };
    expect(verificationSubmission.safeParse({ ...base, status: 'APPROVED' }).success).toBe(false);
    expect(verificationSubmission.safeParse({ ...base, qualificationIds: [id, id] }).success).toBe(
      false,
    );
  });
  it('rejects contradictory affiliation dates and oversized discovery scans', () => {
    const id = String(new Types.ObjectId());
    expect(
      affiliationInput.safeParse({
        doctorId: id,
        facilityId: id,
        title: 'Consultant',
        department: 'Medicine',
        validFrom: '2027-02-01T00:00:00Z',
        validUntil: '2027-01-01T00:00:00Z',
      }).success,
    ).toBe(false);
    expect(discoveryQuery.safeParse({ limit: 26 }).success).toBe(false);
    expect(discoveryQuery.safeParse({ doctorId: { $ne: null } }).success).toBe(false);
    expect(discoveryQuery.safeParse({ includeUnverified: true }).success).toBe(false);
  });
});
