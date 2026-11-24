import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { initializeFoundation, seedStarterSpecialties } from '../../src/database/foundation.js';
import { upgradeProviderPermissions } from '../../src/database/provider-permissions.js';
import { User } from '../../src/modules/admin/auth/models/user.model.js';
import { Session } from '../../src/modules/admin/auth/models/session.model.js';
import { generateAccessToken } from '../../src/modules/admin/auth/auth.jwt.js';
import { SUPER_ADMIN_ROLE } from '../../src/modules/admin/auth/auth.constants.js';
import { ensureSystemRoles } from '../../src/modules/admin/auth/roles/role.service.js';
import * as organizations from '../../src/modules/organizations/organization.service.js';
import * as organizationDto from '../../src/modules/organizations/organization.validation.js';
import * as memberships from '../../src/modules/access/membership.service.js';
import { inviteInput } from '../../src/modules/access/membership.validation.js';
import { Membership, ScopedRole } from '../../src/modules/access/access.model.js';
import * as practitioners from '../../src/modules/practitioners/practitioner.service.js';
import * as practitionerDto from '../../src/modules/practitioners/practitioner.validation.js';
import {
  Doctor,
  Specialty,
  ProfessionalRegistration,
  PractitionerQualification,
} from '../../src/modules/practitioners/practitioner.model.js';
import * as verification from '../../src/modules/providers/verification.service.js';
import * as affiliations from '../../src/modules/providers/affiliation.service.js';
import {
  DoctorVerificationCase,
  DoctorAffiliation,
} from '../../src/modules/providers/provider.model.js';
import { discoverDoctors } from '../../src/modules/providers/discovery.service.js';
import { AuditEvent, OutboxEvent } from '../../src/modules/operations/operation.model.js';
import { todayInIndia, type CommandActor } from '../../src/shared/domain/healthcare.js';

const app = createApp();
const key = () => randomUUID();
const databaseName = `docduniya_test_${randomUUID().replaceAll('-', '')}`;
let replicaSet: MongoMemoryReplSet | undefined;
const address = {
  use: 'WORK',
  line1: 'Public Clinic Road',
  city: 'Kolkata',
  stateCode: 'WB',
  postalCode: '700001',
};
type Identity = { actor: CommandActor; token: string };
const checks = {
  identityChecked: true,
  registrationChecked: true,
  qualificationsChecked: true,
} as const;
const approval = () => ({
  expectedVersion: 0,
  decision: 'APPROVED' as const,
  reason: 'Independent synthetic review of identity and credentials.',
  checks,
  validUntil: new Date(Date.now() + 30 * 86400_000).toISOString(),
});

async function account(role = 'user'): Promise<Identity> {
  const user = await User.create({
    email: `${key()}@example.test`,
    isActive: true,
    isVerified: true,
    role,
  });
  const session = await Session.create({
    userId: user._id,
    refreshTokenHash: key(),
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return {
    actor: { userId: String(user._id), requestId: key() },
    token: generateAccessToken(String(user._id), role, String(session._id)),
  };
}
async function provider(owner: Identity, reviewer: Identity) {
  const org = await organizations.createOrganization(
    owner.actor,
    organizationDto.organizationInput.parse({
      kind: 'CLINIC',
      legalName: 'Synthetic Provider',
      displayName: 'Synthetic Provider',
      slug: `clinic-${key()}`,
      legalAddress: address,
    }),
    key(),
  );
  const facility = await organizations.createFacility(
    owner.actor,
    org.id,
    organizationDto.facilityInput.parse({
      name: 'Public Clinic',
      code: 'MAIN',
      kind: 'CLINIC',
      address,
    }),
    key(),
  );
  const review = await organizations.submitVerification(
    owner.actor,
    org.id,
    {
      expectedVersion: 0,
      declaration: 'Synthetic provider declaration.',
      evidenceReferences: ['test-provider-evidence'],
    },
    key(),
  );
  await organizations.decideVerification(
    reviewer.actor,
    review.id,
    { expectedVersion: 0, decision: 'APPROVED', reason: 'Independent synthetic provider review.' },
    key(),
  );
  await organizations.changeFacilityState(
    owner.actor,
    org.id,
    facility.id,
    { expectedVersion: 0, status: 'ACTIVE', reason: 'Open synthetic clinic' },
    key(),
  );
  return { org, facility };
}
async function candidate(identity: Identity, number = key()) {
  const specialty = (await Specialty.findOne({ status: 'ACTIVE' }))!;
  const profile = practitionerDto.practitionerInput.parse({
    name: { display: 'Private Legal Identity' },
    birthDate: '1980-01-01',
    profession: 'DOCTOR',
    residentialAddresses: [{ ...address, use: 'HOME', line1: 'Secret Residence Road' }],
    contacts: [{ kind: 'EMAIL', value: 'secret@example.test', use: 'PERSONAL' }],
  });
  const practitioner = await practitioners.createPractitioner(identity.actor, profile, key());
  const doctor = await practitioners.createDoctor(
    identity.actor,
    practitionerDto.doctorInput.parse({
      slug: `doctor-${key()}`,
      publicName: 'Dr Synthetic',
      bio: 'Synthetic public professional biography.',
      specialtyIds: [String(specialty._id)],
    }),
    key(),
  );
  const qualification = await practitioners.addCredential(
    identity.actor,
    'qualifications',
    practitionerDto.qualificationInput.parse({
      kind: 'DEGREE',
      qualificationName: 'Synthetic qualification',
      institutionName: 'Synthetic institution',
      awardYear: 2010,
      evidenceReference: 'secret-degree-evidence',
    }),
    key(),
  );
  const registration = await practitioners.addCredential(
    identity.actor,
    'registrations',
    practitionerDto.professionalRegistrationInput.parse({
      authority: 'Synthetic test council',
      jurisdiction: 'WB',
      registrationNumberNormalized: number,
      issuedOn: '2010-01-01',
      expiresOn: todayInIndia(new Date(Date.now() + 90 * 86400_000)),
      evidenceReference: 'secret-registration-evidence',
    }),
    key(),
  );
  return { identity, profile, practitioner, doctor, qualification, registration };
}
type Candidate = Awaited<ReturnType<typeof candidate>>;
async function submit(subject: Candidate) {
  const doctor = await practitioners.getDoctor(subject.identity.actor);
  return verification.submitDoctorVerification(
    subject.identity.actor,
    {
      expectedVersion: doctor.version,
      registrationId: subject.registration.id,
      qualificationIds: [subject.qualification.id],
      declaration: 'Synthetic accurate credentials declaration.',
    },
    key(),
  );
}
async function verify(subject: Candidate, reviewer: Identity) {
  const review = await submit(subject);
  await verification.decideDoctorVerification(reviewer.actor, review.id, approval(), key());
  return review;
}
async function staff(
  owner: Identity,
  identity: Identity,
  orgId: string,
  facilityId: string,
  role: 'clinician' | 'administrator' = 'clinician',
) {
  const invitation = await memberships.inviteMember(
    owner.actor,
    orgId,
    inviteInput.parse({
      userId: identity.actor.userId,
      role,
      facilityScope: role === 'administrator' ? 'ALL' : 'SELECTED',
      facilityIds: role === 'administrator' ? [] : [facilityId],
    }),
    key(),
  );
  return memberships.acceptInvitation(
    identity.actor,
    invitation.id,
    { expectedVersion: invitation.version },
    key(),
  );
}
async function invite(owner: Identity, subject: Candidate, orgId: string, facilityId: string) {
  return affiliations.inviteAffiliation(
    owner.actor,
    orgId,
    {
      doctorId: subject.doctor.id,
      facilityId,
      title: 'Consultant',
      department: 'General medicine',
    },
    key(),
  );
}
async function publish(subject: Candidate) {
  const doctor = await practitioners.getDoctor(subject.identity.actor);
  return affiliations.publishDoctor(
    subject.identity.actor,
    { expectedVersion: doctor.version, published: true },
    key(),
  );
}
const listing = (doctorId: string) => discoverDoctors({ doctorId, limit: 25 });

beforeAll(async () => {
  let uri = process.env.TEST_MONGO_URI;
  if (!uri) {
    replicaSet = await MongoMemoryReplSet.create({
      binary: { version: '8.2.6', downloadDir: resolve('.cache/mongodb') },
      instanceOpts: [{ launchTimeout: 60_000 }],
      replSet: { count: 1, storageEngine: 'wiredTiger', spawn: { windowsHide: true } },
    });
    uri = replicaSet.getUri();
  }
  const parsed = new URL(uri);
  if (parsed.protocol !== 'mongodb:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname))
    throw new Error('Tests only accept a local replica set');
  await mongoose.connect(uri, {
    dbName: databaseName,
    autoIndex: false,
    autoCreate: false,
    serverSelectionTimeoutMS: 5000,
  });
  await initializeFoundation();
  await ensureSystemRoles();
  await seedStarterSpecialties();
});
afterAll(async () => {
  if (
    mongoose.connection.readyState === 1 &&
    mongoose.connection.name === databaseName &&
    /^docduniya_test_[a-f0-9]{32}$/.test(databaseName)
  )
    await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await replicaSet?.stop();
});

describe('Reviewed doctor profiles and marketplace affiliations', () => {
  it('checks credential ownership, independent review, sealed identity and private evidence access', async () => {
    const doctorAccount = await account(SUPER_ADMIN_ROLE);
    const reviewer = await account(SUPER_ADMIN_ROLE);
    const colleague = await account(SUPER_ADMIN_ROLE);
    const outsider = await account();
    const subject = await candidate(doctorAccount);
    const other = await candidate(outsider);
    const clinic = await provider(doctorAccount, reviewer);
    await staff(doctorAccount, colleague, clinic.org.id, clinic.facility.id, 'administrator');
    await expect(
      verification.submitDoctorVerification(
        doctorAccount.actor,
        {
          expectedVersion: 0,
          registrationId: other.registration.id,
          qualificationIds: [subject.qualification.id],
          declaration: 'Attempt to use someone else registration.',
        },
        key(),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    const review = await submit(subject);
    await expect(
      verification.decideDoctorVerification(doctorAccount.actor, review.id, approval(), key()),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      verification.decideDoctorVerification(colleague.actor, review.id, approval(), key()),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      practitioners.updatePractitioner(
        doctorAccount.actor,
        {
          expectedVersion: 0,
          profile: { ...subject.profile, name: { display: 'Swapped identity' } },
        },
        key(),
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const privateRead = await request(app)
      .get(`/api/v1/doctors/me/verification-requests/${review.id}`)
      .set('Authorization', `Bearer ${outsider.token}`);
    expect(privateRead.status).toBe(404);
    const permitted = await request(app)
      .get(`/api/v1/platform/doctor-verifications/${review.id}`)
      .set('Authorization', `Bearer ${reviewer.token}`);
    expect(permitted.status).toBe(200);
    expect(permitted.body.data.identitySnapshot.name.display).toBe('Private Legal Identity');
    await expect(
      verification.decideDoctorVerification(
        reviewer.actor,
        review.id,
        { ...approval(), validUntil: new Date(Date.now() + 400 * 86400_000).toISOString() },
        key(),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    const idempotency = key();
    const decision = approval();
    const first = await verification.decideDoctorVerification(
      reviewer.actor,
      review.id,
      decision,
      idempotency,
    );
    expect(
      await verification.decideDoctorVerification(reviewer.actor, review.id, decision, idempotency),
    ).toEqual(first);
    expect(
      await AuditEvent.countDocuments({
        resourceId: review.id,
        action: 'DoctorVerificationAPPROVED',
      }),
    ).toBe(1);
    const doctor = await practitioners.getDoctor(doctorAccount.actor);
    await verification.withdrawDoctorVerification(
      doctorAccount.actor,
      { expectedVersion: doctor.version, reason: 'Correct professional identity' },
      key(),
    );
    await practitioners.updatePractitioner(
      doctorAccount.actor,
      {
        expectedVersion: 0,
        profile: { ...subject.profile, name: { display: 'Corrected identity' } },
      },
      key(),
    );
    expect((await DoctorVerificationCase.findById(review.id))!.identitySnapshot.name.display).toBe(
      'Private Legal Identity',
    );
  });

  it('requires two-sided acceptance and exposes only safe public fields while scope remains current', async () => {
    const owner = await account();
    const reviewer = await account(SUPER_ADMIN_ROLE);
    const doctorAccount = await account();
    const wrongDoctor = await candidate(await account());
    const subject = await candidate(doctorAccount);
    await verify(subject, reviewer);
    await expect(publish(subject)).rejects.toMatchObject({ statusCode: 400 });
    const clinic = await provider(owner, reviewer);
    const membership = await staff(owner, doctorAccount, clinic.org.id, clinic.facility.id);
    const affiliation = await invite(owner, subject, clinic.org.id, clinic.facility.id);
    await expect(
      affiliations.respondToAffiliation(
        wrongDoctor.identity.actor,
        affiliation.id,
        { expectedVersion: 0, decision: 'ACCEPT' },
        key(),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      affiliations.changeAffiliation(
        owner.actor,
        clinic.org.id,
        affiliation.id,
        { expectedVersion: 0, status: 'ACTIVE', reason: 'Cannot accept on behalf' },
        key(),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    const accepted = await affiliations.respondToAffiliation(
      doctorAccount.actor,
      affiliation.id,
      { expectedVersion: 0, decision: 'ACCEPT' },
      key(),
    );
    await publish(subject);
    const response = await request(app).get(
      `/api/v1/discovery/doctors?doctorId=${subject.doctor.id}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0]).toMatchObject({
      id: affiliation.id,
      publicName: 'Dr Synthetic',
      bookable: false,
      facility: { name: 'Public Clinic' },
    });
    const serialized = JSON.stringify(response.body);
    for (const secret of [
      'Secret Residence Road',
      'secret@example.test',
      'secret-degree-evidence',
      'secret-registration-evidence',
      'Private Legal Identity',
      'submittedBy',
      'registrationNumberNormalized',
    ])
      expect(serialized).not.toContain(secret);
    await organizations.changeFacilityState(
      owner.actor,
      clinic.org.id,
      clinic.facility.id,
      { expectedVersion: 1, status: 'INACTIVE', reason: 'Temporarily closed' },
      key(),
    );
    expect((await listing(subject.doctor.id)).items).toHaveLength(0);
    await organizations.changeFacilityState(
      owner.actor,
      clinic.org.id,
      clinic.facility.id,
      { expectedVersion: 2, status: 'ACTIVE', reason: 'Clinic reopened' },
      key(),
    );
    expect((await listing(subject.doctor.id)).items).toHaveLength(1);
    const ended = await memberships.changeMembership(
      owner.actor,
      clinic.org.id,
      membership.id,
      { expectedVersion: membership.version, status: 'ENDED', reason: 'Employment ended' },
      key(),
    );
    expect((await listing(subject.doctor.id)).items).toHaveLength(0);
    const renewed = await staff(owner, doctorAccount, clinic.org.id, clinic.facility.id);
    expect(renewed.id).toBe(ended.id);
    expect((await listing(subject.doctor.id)).items).toHaveLength(0);
    await affiliations.changeAffiliation(
      owner.actor,
      clinic.org.id,
      affiliation.id,
      { expectedVersion: accepted.version, status: 'ENDED', reason: 'Replace former affiliation' },
      key(),
    );
    const fresh = await invite(owner, subject, clinic.org.id, clinic.facility.id);
    await affiliations.respondToAffiliation(
      doctorAccount.actor,
      fresh.id,
      { expectedVersion: 0, decision: 'ACCEPT' },
      key(),
    );
    expect((await listing(subject.doctor.id)).items.map((v) => v.id)).toEqual([fresh.id]);
    expect(await DoctorAffiliation.countDocuments({ doctorId: subject.doctor.id })).toBe(2);
  });

  it('retains verification history and requires re-verification after suspension is lifted', async () => {
    const doctorAccount = await account();
    const reviewer = await account(SUPER_ADMIN_ROLE);
    const subject = await candidate(doctorAccount);
    await verify(subject, reviewer);
    const clinic = await provider(doctorAccount, reviewer);
    const affiliation = await invite(doctorAccount, subject, clinic.org.id, clinic.facility.id);
    await affiliations.respondToAffiliation(
      doctorAccount.actor,
      affiliation.id,
      { expectedVersion: 0, decision: 'ACCEPT' },
      key(),
    );
    const published = await publish(subject);
    const suspended = await verification.restrictDoctor(
      reviewer.actor,
      subject.doctor.id,
      {
        expectedVersion: published.version,
        status: 'SUSPENDED',
        reason: 'Synthetic credential concern requiring review.',
      },
      key(),
    );
    expect((await listing(subject.doctor.id)).items).toHaveLength(0);
    await expect(
      verification.withdrawDoctorVerification(
        doctorAccount.actor,
        { expectedVersion: suspended.version, reason: 'Attempt to bypass restriction' },
        key(),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    const released = await verification.restrictDoctor(
      reviewer.actor,
      subject.doctor.id,
      {
        expectedVersion: suspended.version,
        status: 'UNVERIFIED',
        reason: 'Concern resolved; independent re-review required.',
      },
      key(),
    );
    await expect(
      affiliations.publishDoctor(
        doctorAccount.actor,
        { expectedVersion: released.version, published: true },
        key(),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    await verify(subject, reviewer);
    await publish(subject);
    expect((await listing(subject.doctor.id)).items).toHaveLength(1);
    expect(
      await DoctorVerificationCase.countDocuments({
        doctorId: subject.doctor.id,
        status: 'APPROVED',
      }),
    ).toBe(2);
  });

  it('rolls back every approval effect when a verified registration is already claimed', async () => {
    const reviewer = await account(SUPER_ADMIN_ROLE);
    const number = key();
    const first = await candidate(await account(), number);
    const second = await candidate(await account(), number);
    await verify(first, reviewer);
    const review = await submit(second);
    await expect(
      verification.decideDoctorVerification(reviewer.actor, review.id, approval(), key()),
    ).rejects.toMatchObject({ code: 11000 });
    expect((await Doctor.findById(second.doctor.id))!.verificationStatus).toBe('IN_REVIEW');
    expect((await DoctorVerificationCase.findById(review.id))!.status).toBe('SUBMITTED');
    expect((await PractitionerQualification.findById(second.qualification.id))!.status).toBe(
      'DECLARED',
    );
    expect(
      await OutboxEvent.countDocuments({
        aggregateId: review.id,
        type: 'DoctorVerificationAPPROVED',
      }),
    ).toBe(0);
  });

  it('filters expired credentials and rejects cross-provider affiliation management', async () => {
    const reviewer = await account(SUPER_ADMIN_ROLE);
    const owner = await account();
    const otherOwner = await account();
    const subject = await candidate(await account());
    await verify(subject, reviewer);
    const a = await provider(owner, reviewer);
    const b = await provider(otherOwner, reviewer);
    await staff(owner, subject.identity, a.org.id, a.facility.id);
    await expect(invite(owner, subject, a.org.id, b.facility.id)).rejects.toMatchObject({
      statusCode: 404,
    });
    const affiliation = await invite(owner, subject, a.org.id, a.facility.id);
    const accepted = await affiliations.respondToAffiliation(
      subject.identity.actor,
      affiliation.id,
      { expectedVersion: 0, decision: 'ACCEPT' },
      key(),
    );
    await publish(subject);
    await expect(
      affiliations.changeAffiliation(
        otherOwner.actor,
        b.org.id,
        affiliation.id,
        {
          expectedVersion: accepted.version,
          status: 'ENDED',
          reason: 'Attempt tenant substitution',
        },
        key(),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    await ProfessionalRegistration.updateOne(
      { _id: subject.registration.id },
      { $set: { expiresOn: '2000-01-01' } },
    );
    expect((await listing(subject.doctor.id)).items).toHaveLength(0);
  });

  it('upgrades only built-in organization roles and records the additive migration once', async () => {
    const owner = await account();
    const reviewer = await account(SUPER_ADMIN_ROLE);
    const clinic = await provider(owner, reviewer);
    await ScopedRole.updateMany(
      { organizationId: clinic.org.id },
      { $pull: { permissionCodes: { $in: ['affiliations.manage', 'affiliations.accept'] } } },
    );
    const ownerRole = (await ScopedRole.findOne({ organizationId: clinic.org.id, slug: 'owner' }))!;
    await upgradeProviderPermissions();
    expect((await ScopedRole.findById(ownerRole._id))!.permissionCodes).toContain(
      'affiliations.manage',
    );
    expect(
      (await ScopedRole.findOne({ organizationId: clinic.org.id, slug: 'receptionist' }))!
        .permissionCodes,
    ).not.toContain('affiliations.accept');
    await upgradeProviderPermissions();
    expect(
      await AuditEvent.countDocuments({
        resourceId: ownerRole._id,
        action: 'ProviderPermissionsAdded',
      }),
    ).toBe(1);
    expect(await Membership.countDocuments({ organizationId: clinic.org.id })).toBe(1);
  });
});
