import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose, { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { initializeFoundation, seedStarterSpecialties } from '../../src/database/foundation.js';
import { User } from '../../src/modules/admin/auth/models/user.model.js';
import { Session } from '../../src/modules/admin/auth/models/session.model.js';
import { generateAccessToken } from '../../src/modules/admin/auth/auth.jwt.js';
import { SUPER_ADMIN_ROLE } from '../../src/modules/admin/auth/auth.constants.js';
import { ensureSystemRoles } from '../../src/modules/admin/auth/roles/role.service.js';
import {
  Organization,
  Facility,
  VerificationCase,
} from '../../src/modules/organizations/organization.model.js';
import * as organizations from '../../src/modules/organizations/organization.service.js';
import * as organizationDto from '../../src/modules/organizations/organization.validation.js';
import { Membership, ScopedRole, RoleAssignment } from '../../src/modules/access/access.model.js';
import * as memberships from '../../src/modules/access/membership.service.js';
import { inviteInput } from '../../src/modules/access/membership.validation.js';
import { authorizeOrganization } from '../../src/modules/access/access.service.js';
import { ROLE_TEMPLATES } from '../../src/modules/access/access.constants.js';
import * as patients from '../../src/modules/patients/patient.service.js';
import * as patientDto from '../../src/modules/patients/patient.validation.js';
import {
  Patient,
  PatientRegistration,
  PatientRelationship,
} from '../../src/modules/patients/patient.model.js';
import * as practitioners from '../../src/modules/practitioners/practitioner.service.js';
import * as practitionerDto from '../../src/modules/practitioners/practitioner.validation.js';
import {
  AuditEvent,
  OutboxEvent,
  IdempotencyKey,
} from '../../src/modules/operations/operation.model.js';
import { recordChange } from '../../src/modules/operations/operation.service.js';
import { command } from '../../src/shared/application/command.js';
import { stamp } from '../../src/shared/persistence/schema.js';
import type { CommandActor } from '../../src/shared/domain/healthcare.js';

const app = createApp();
const key = () => randomUUID();
const databaseName = `docduniya_test_${randomUUID().replaceAll('-', '')}`;
let replicaSet: MongoMemoryReplSet | undefined;
const address = {
  use: 'WORK',
  line1: 'Example Road',
  city: 'Kolkata',
  stateCode: 'WB',
  postalCode: '700001',
};
const profile = patientDto.demographicsInput.parse({
  name: { display: 'Synthetic Patient' },
  birthDate: '2000-02-29',
});
const pagination = { limit: 25 };
type Identity = { actor: CommandActor; token: string };

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
  const userId = String(user._id);
  return {
    actor: { userId, requestId: key() },
    token: generateAccessToken(userId, role, String(session._id)),
  };
}
function orgInput() {
  return organizationDto.organizationInput.parse({
    kind: 'CLINIC',
    legalName: 'Synthetic Clinic',
    displayName: 'Synthetic Clinic',
    slug: `clinic-${key()}`,
    legalAddress: address,
  });
}
async function provider(owner: Identity, reviewer: Identity, active = true) {
  const org = await organizations.createOrganization(owner.actor, orgInput(), key());
  const facility = await organizations.createFacility(
    owner.actor,
    org.id,
    organizationDto.facilityInput.parse({
      name: 'Main Clinic',
      code: 'MAIN',
      kind: 'CLINIC',
      address,
    }),
    key(),
  );
  if (active) {
    const review = await organizations.submitVerification(
      owner.actor,
      org.id,
      {
        expectedVersion: 0,
        declaration: 'Synthetic test declaration only.',
        evidenceReferences: ['synthetic-test-case'],
      },
      key(),
    );
    await organizations.decideVerification(
      reviewer.actor,
      review.id,
      {
        expectedVersion: 0,
        decision: 'APPROVED',
        reason: 'Synthetic independent verification for automated test.',
      },
      key(),
    );
    await organizations.changeFacilityState(
      owner.actor,
      org.id,
      facility.id,
      { expectedVersion: 0, status: 'ACTIVE', reason: 'Synthetic activation' },
      key(),
    );
  }
  return { org, facility };
}

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
    throw new Error('Integration tests only accept a local MongoDB replica set');
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
  // Never drop an existing application database, even if TEST_MONGO_URI names one.
  if (
    mongoose.connection.readyState === 1 &&
    mongoose.connection.name === databaseName &&
    /^docduniya_test_[a-f0-9]{32}$/.test(databaseName)
  )
    await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await replicaSet?.stop();
});

describe('Foundation on a real MongoDB replica set', () => {
  it('atomically bootstraps ownership, roles, audit and outbox once under concurrent replay', async () => {
    const owner = await account();
    const input = orgInput();
    const idempotency = key();
    const results = await Promise.all([
      organizations.createOrganization(owner.actor, input, idempotency),
      organizations.createOrganization(owner.actor, input, idempotency),
    ]);
    expect(results[0]).toEqual(results[1]);
    const organizationId = results[0]!.id;
    expect(await Organization.countDocuments({ _id: organizationId })).toBe(1);
    expect(await Membership.countDocuments({ organizationId, status: 'ACTIVE' })).toBe(1);
    expect(await ScopedRole.countDocuments({ organizationId })).toBe(ROLE_TEMPLATES.length);
    expect(await RoleAssignment.countDocuments({ organizationId })).toBe(1);
    expect(
      await AuditEvent.countDocuments({
        resourceId: organizationId,
        action: 'OrganizationCreated',
      }),
    ).toBe(1);
    expect(await OutboxEvent.countDocuments({ aggregateId: organizationId })).toBe(1);
    const audit = (await AuditEvent.findOne({ resourceId: organizationId }))!;
    audit.reason = 'Attempt to alter audit history';
    await expect(audit.save()).rejects.toThrow('append-only');
    await expect(AuditEvent.deleteOne({ _id: audit._id })).rejects.toThrow('append-only');
    await expect(
      organizations.createOrganization(
        owner.actor,
        { ...input, displayName: 'Different' },
        idempotency,
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('rolls back business writes, audit, outbox and idempotency together', async () => {
    const owner = await account();
    const resourceId = String(new Types.ObjectId());
    const idempotency = key();
    await expect(
      command(owner.actor, 'test', 'rollback', idempotency, {}, async (session) => {
        await Patient.create(
          [
            {
              _id: resourceId,
              ...profile,
              ...stamp(owner.actor.userId),
              birthDatePrecision: 'EXACT',
            },
          ],
          { session },
        );
        await recordChange(
          owner.actor,
          {
            patientId: resourceId,
            action: 'RollbackProbe',
            resourceType: 'patient',
            resourceId,
            version: 0,
          },
          session,
        );
        throw new Error('Deliberate rollback');
      }),
    ).rejects.toThrow('Deliberate rollback');
    expect(await Patient.exists({ _id: resourceId })).toBeNull();
    expect(await AuditEvent.countDocuments({ resourceId })).toBe(0);
    expect(await OutboxEvent.countDocuments({ aggregateId: resourceId })).toBe(0);
    expect(await IdempotencyKey.countDocuments({ key: idempotency })).toBe(0);
  });

  it('requires an independent reviewer and active facilities before receiving patients', async () => {
    const owner = await account(SUPER_ADMIN_ROLE);
    const reviewer = await account(SUPER_ADMIN_ROLE);
    const { org, facility } = await provider(owner, reviewer, false);
    await expect(
      patients.createProviderRegistration(
        owner.actor,
        org.id,
        { facilityId: facility.id, profile },
        key(),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_NOT_ACTIVE' });
    const review = await organizations.submitVerification(
      owner.actor,
      org.id,
      {
        expectedVersion: 0,
        declaration: 'Synthetic legal declaration for review.',
        evidenceReferences: ['test-case'],
      },
      key(),
    );
    await expect(
      organizations.decideVerification(
        owner.actor,
        review.id,
        {
          expectedVersion: 0,
          decision: 'APPROVED',
          reason: 'Self approval must not be permitted.',
        },
        key(),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    await organizations.decideVerification(
      reviewer.actor,
      review.id,
      {
        expectedVersion: 0,
        decision: 'APPROVED',
        reason: 'Independent synthetic approval record.',
      },
      key(),
    );
    await expect(
      patients.createProviderRegistration(
        owner.actor,
        org.id,
        { facilityId: facility.id, profile },
        key(),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect((await VerificationCase.findById(review.id))!.status).toBe('APPROVED');
    expect((await Facility.findById(facility.id))!.status).toBe('DRAFT');
  });

  it('enforces tenant and facility boundaries, target-only invitations and revocation', async () => {
    const owner = await account();
    const other = await account();
    const staff = await account();
    const reviewer = await account(SUPER_ADMIN_ROLE);
    const a = await provider(owner, reviewer);
    const b = await provider(other, reviewer);
    await expect(organizations.getOrganization(reviewer.actor, a.org.id)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      memberships.inviteMember(
        owner.actor,
        a.org.id,
        inviteInput.parse({
          userId: staff.actor.userId,
          role: 'receptionist',
          facilityScope: 'SELECTED',
          facilityIds: [b.facility.id],
        }),
        key(),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    const invitation = await memberships.inviteMember(
      owner.actor,
      a.org.id,
      inviteInput.parse({
        userId: staff.actor.userId,
        role: 'receptionist',
        facilityScope: 'SELECTED',
        facilityIds: [a.facility.id],
      }),
      key(),
    );
    await expect(
      authorizeOrganization(staff.actor, a.org.id, 'patients.register'),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      memberships.acceptInvitation(other.actor, invitation.id, { expectedVersion: 0 }, key()),
    ).rejects.toMatchObject({ statusCode: 404 });
    const accepted = await memberships.acceptInvitation(
      staff.actor,
      invitation.id,
      { expectedVersion: 0 },
      key(),
    );
    const local = await patients.createProviderRegistration(
      staff.actor,
      a.org.id,
      { facilityId: a.facility.id, profile },
      key(),
    );
    await expect(patients.getRegistration(other.actor, b.org.id, local.id)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      patients.createProviderRegistration(
        staff.actor,
        a.org.id,
        { facilityId: b.facility.id, profile },
        key(),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(
      (await patients.listRegistrations(staff.actor, a.org.id, pagination)).items.map((r) => r.id),
    ).toContain(local.id);
    await memberships.changeMembership(
      owner.actor,
      a.org.id,
      invitation.id,
      { expectedVersion: accepted.version, status: 'SUSPENDED', reason: 'Synthetic suspension' },
      key(),
    );
    await expect(patients.getRegistration(staff.actor, a.org.id, local.id)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('separates patient identity from provider snapshots and rejects stale edits', async () => {
    const owner = await account();
    const patientAccount = await account();
    const reviewer = await account(SUPER_ADMIN_ROLE);
    const { org, facility } = await provider(owner, reviewer);
    const patient = await patients.createPatient(
      patientAccount.actor,
      { kind: 'SELF', profile },
      key(),
    );
    const registered = await patients.registerSelfAtProvider(
      patientAccount.actor,
      patient.id,
      { organizationId: org.id, facilityId: facility.id },
      key(),
    );
    await patients.updatePatient(
      patientAccount.actor,
      patient.id,
      {
        expectedVersion: 0,
        profile: { ...profile, name: { display: 'Updated private identity' } },
      },
      key(),
    );
    expect(
      (await patients.getRegistration(owner.actor, org.id, registered.id)).profile.name.display,
    ).toBe('Synthetic Patient');
    await patients.updateRegistration(
      owner.actor,
      org.id,
      registered.id,
      {
        expectedVersion: 0,
        profile: { ...profile, name: { display: 'Local correction' } },
        reason: 'Synthetic local correction',
      },
      key(),
    );
    expect((await patients.getPatient(patientAccount.actor, patient.id)).name.display).toBe(
      'Updated private identity',
    );
    await expect(patients.getPatient(owner.actor, patient.id)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(patients.getPatient(reviewer.actor, patient.id)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      patients.updatePatient(
        patientAccount.actor,
        patient.id,
        { expectedVersion: 0, profile },
        key(),
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const parallel = await Promise.all(
      Array.from({ length: 4 }, () =>
        patients.createProviderRegistration(
          owner.actor,
          org.id,
          { facilityId: facility.id, profile },
          key(),
        ),
      ),
    );
    const rows = await PatientRegistration.find({ _id: { $in: parallel.map((r) => r.id) } }).lean();
    expect(new Set(rows.map((r) => r.mrn)).size).toBe(4);
    const replay = await patients.registerSelfAtProvider(
      patientAccount.actor,
      patient.id,
      { organizationId: org.id, facilityId: facility.id },
      key(),
    );
    expect(replay.id).toBe(registered.id);
  });

  it('requires reviewed, unexpired representative authority and removes access on revocation', async () => {
    const guardian = await account();
    const reviewer = await account(SUPER_ADMIN_ROLE);
    const patient = await patients.createPatient(
      guardian.actor,
      {
        kind: 'DEPENDENT',
        profile,
        relationship: 'GUARDIAN',
        authorityReference: 'synthetic-authority-case',
      },
      key(),
    );
    const relationship = (await PatientRelationship.findOne({ patientId: patient.id }))!;
    await expect(patients.getPatient(guardian.actor, patient.id)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      patients.decideRelationship(
        guardian.actor,
        String(relationship._id),
        {
          expectedVersion: 0,
          decision: 'ACTIVE',
          reason: 'Unprivileged reviewer cannot grant access.',
          validUntil: new Date(Date.now() + 86400_000).toISOString(),
        },
        key(),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    const approved = await patients.decideRelationship(
      reviewer.actor,
      String(relationship._id),
      {
        expectedVersion: 0,
        decision: 'ACTIVE',
        reason: 'Independent synthetic authority review.',
        validUntil: new Date(Date.now() + 86400_000).toISOString(),
      },
      key(),
    );
    expect((await patients.getPatient(guardian.actor, patient.id)).id).toBe(patient.id);
    await PatientRelationship.updateOne(
      { _id: approved.id },
      { $set: { validUntil: new Date(Date.now() - 1000) } },
    );
    await expect(patients.getPatient(guardian.actor, patient.id)).rejects.toMatchObject({
      statusCode: 404,
    });
    await patients.revokeRelationship(
      guardian.actor,
      approved.id,
      { expectedVersion: approved.version, reason: 'Authority relinquished' },
      key(),
    );
    await expect(patients.getPatient(guardian.actor, patient.id)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('keeps professional declarations private and prevents self-verification through HTTP', async () => {
    const doctor = await account();
    const outsider = await account();
    await practitioners.createPractitioner(
      doctor.actor,
      practitionerDto.practitionerInput.parse({
        name: { display: 'Synthetic Doctor' },
        profession: 'DOCTOR',
        residentialAddresses: [{ ...address, use: 'HOME' }],
      }),
      key(),
    );
    await practitioners.createDoctor(
      doctor.actor,
      practitionerDto.doctorInput.parse({
        slug: `doctor-${key()}`,
        publicName: 'Synthetic Doctor',
        bio: 'Synthetic professional biography.',
      }),
      key(),
    );
    await practitioners.addCredential(
      doctor.actor,
      'employment',
      practitionerDto.employmentInput.parse({
        employerName: 'Synthetic Hospital',
        employerAddress: address,
        title: 'Doctor',
        department: 'Medicine',
        startDate: '2020-01-01',
        employmentType: 'FULL_TIME',
      }),
      key(),
    );
    expect((await practitioners.getDoctor(doctor.actor)).verificationStatus).toBe('UNVERIFIED');
    expect(
      (await practitioners.listCredentials(doctor.actor, 'employment', pagination)).items,
    ).toHaveLength(1);
    const privateRead = await request(app)
      .get('/api/v1/practitioners/me')
      .set('Authorization', `Bearer ${outsider.token}`);
    expect(privateRead.status).toBe(404);
    const forged = await request(app)
      .patch('/api/v1/doctors/me')
      .set('Authorization', `Bearer ${doctor.token}`)
      .set('Idempotency-Key', key())
      .send({
        expectedVersion: 0,
        profile: {
          slug: 'forged',
          publicName: 'Fake',
          bio: 'A forged verified profile.',
          verificationStatus: 'VERIFIED',
        },
      });
    expect(forged.status).toBe(400);
    expect(forged.headers['x-request-id']).toBeTruthy();
    const declaration = practitionerDto.professionalRegistrationInput.parse({
      authority: 'Synthetic council',
      jurisdiction: 'WB',
      registrationNumberNormalized: key(),
      evidenceReference: 'synthetic-reference',
    });
    await practitioners.addCredential(doctor.actor, 'registrations', declaration, key());
    await expect(
      practitioners.addCredential(doctor.actor, 'registrations', declaration, key()),
    ).rejects.toMatchObject({ code: 11000 });
    await practitioners.createPractitioner(
      outsider.actor,
      practitionerDto.practitionerInput.parse({
        name: { display: 'Another synthetic doctor' },
        profession: 'DOCTOR',
      }),
      key(),
    );
    // An unverified declaration cannot squat a credential number and block its legitimate holder.
    await expect(
      practitioners.addCredential(outsider.actor, 'registrations', declaration, key()),
    ).resolves.toHaveProperty('id');
  });

  it('rejects stale global roles, disabled accounts and missing idempotency keys at HTTP boundary', async () => {
    const downgraded = await account(SUPER_ADMIN_ROLE);
    await User.updateOne({ _id: downgraded.actor.userId }, { $set: { role: 'user' } });
    expect(
      (
        await request(app)
          .get('/api/v1/platform/provider-verifications')
          .set('Authorization', `Bearer ${downgraded.token}`)
      ).status,
    ).toBe(403);
    const missingKey = await request(app)
      .post('/api/v1/patients')
      .set('Authorization', `Bearer ${downgraded.token}`)
      .send({ kind: 'SELF', profile: { name: { display: 'Synthetic' } } });
    expect(missingKey.status).toBe(400);
    await User.updateOne({ _id: downgraded.actor.userId }, { $set: { isActive: false } });
    expect(
      (
        await request(app)
          .get('/api/v1/me/patients')
          .set('Authorization', `Bearer ${downgraded.token}`)
      ).status,
    ).toBe(401);
  });
});
