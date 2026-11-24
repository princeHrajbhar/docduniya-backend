/**
 * Shared synthetic fixtures for replica-set integration suites. Every suite uses its own random
 * database and drops only that database.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { initializeFoundation, seedStarterSpecialties } from '../../src/database/foundation.js';
import { User } from '../../src/modules/admin/auth/models/user.model.js';
import { Session } from '../../src/modules/admin/auth/models/session.model.js';
import { generateAccessToken } from '../../src/modules/admin/auth/auth.jwt.js';
import { SUPER_ADMIN_ROLE } from '../../src/modules/admin/auth/auth.constants.js';
import { ensureSystemRoles } from '../../src/modules/admin/auth/roles/role.service.js';
import * as organizations from '../../src/modules/organizations/organization.service.js';
import * as organizationDto from '../../src/modules/organizations/organization.validation.js';
import * as memberships from '../../src/modules/access/membership.service.js';
import { inviteInput } from '../../src/modules/access/membership.validation.js';
import type { AssignableRole } from '../../src/modules/access/access.constants.js';
import * as practitioners from '../../src/modules/practitioners/practitioner.service.js';
import * as practitionerDto from '../../src/modules/practitioners/practitioner.validation.js';
import { Specialty } from '../../src/modules/practitioners/practitioner.model.js';
import * as verification from '../../src/modules/providers/verification.service.js';
import * as affiliations from '../../src/modules/providers/affiliation.service.js';
import * as patients from '../../src/modules/patients/patient.service.js';
import { createPatientInput } from '../../src/modules/patients/patient.validation.js';
import * as scheduling from '../../src/modules/scheduling/scheduling.service.js';
import * as schedulingDto from '../../src/modules/scheduling/scheduling.validation.js';
import { atIndiaMinute } from '../../src/modules/scheduling/calendar.service.js';
import { todayInIndia, type CommandActor } from '../../src/shared/domain/healthcare.js';

export const key = () => randomUUID();
export const address = {
  use: 'WORK',
  line1: 'Public Clinic Road',
  city: 'Kolkata',
  stateCode: 'WB',
  postalCode: '700001',
};
export type Identity = { actor: CommandActor; token: string; userId: string };

let replicaSet: MongoMemoryReplSet | undefined;
const databaseName = `docduniya_test_${randomUUID().replaceAll('-', '')}`;

export async function startDatabase(): Promise<void> {
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
}

export async function stopDatabase(): Promise<void> {
  if (
    mongoose.connection.readyState === 1 &&
    mongoose.connection.name === databaseName &&
    /^docduniya_test_[a-f0-9]{32}$/.test(databaseName)
  )
    await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await replicaSet?.stop();
}

export async function account(role = 'user'): Promise<Identity> {
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
    userId: String(user._id),
    actor: { userId: String(user._id), requestId: key() },
    token: generateAccessToken(String(user._id), role, String(session._id)),
  };
}
export const platformAdmin = () => account(SUPER_ADMIN_ROLE);

/** A verified provider with one active facility. */
export async function provider(owner: Identity, reviewer: Identity, kind = 'CLINIC') {
  const org = await organizations.createOrganization(
    owner.actor,
    organizationDto.organizationInput.parse({
      kind,
      legalName: 'Synthetic Provider Private Limited',
      displayName: 'Synthetic Provider',
      slug: `provider-${key()}`,
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
      kind: kind === 'HOSPITAL' ? 'HOSPITAL_BRANCH' : 'CLINIC',
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
  return { organizationId: org.id, facilityId: facility.id };
}

export async function staff(
  owner: Identity,
  identity: Identity,
  organizationId: string,
  facilityId: string,
  role: AssignableRole,
) {
  const all = role === 'administrator';
  const invitation = await memberships.inviteMember(
    owner.actor,
    organizationId,
    inviteInput.parse({
      userId: identity.userId,
      role,
      facilityScope: all ? 'ALL' : 'SELECTED',
      facilityIds: all ? [] : [facilityId],
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

/** Practitioner of a non-doctor profession (nurse, pharmacist, laboratory professional). */
export async function professional(
  identity: Identity,
  profession: 'NURSE' | 'PHARMACIST' | 'LAB_PROFESSIONAL',
) {
  return practitioners.createPractitioner(
    identity.actor,
    practitionerDto.practitionerInput.parse({
      name: { display: `Synthetic ${profession.toLowerCase()}` },
      profession,
    }),
    key(),
  );
}

/** Verified, affiliated, published doctor. */
export async function verifiedDoctor(
  doctorAccount: Identity,
  reviewer: Identity,
  owner: Identity,
  clinic: { organizationId: string; facilityId: string },
) {
  const specialty = (await Specialty.findOne({ status: 'ACTIVE' }))!;
  const practitioner = await practitioners.createPractitioner(
    doctorAccount.actor,
    practitionerDto.practitionerInput.parse({
      name: { display: 'Private Legal Identity' },
      birthDate: '1980-01-01',
      profession: 'DOCTOR',
    }),
    key(),
  );
  const doctor = await practitioners.createDoctor(
    doctorAccount.actor,
    practitionerDto.doctorInput.parse({
      slug: `doctor-${key()}`,
      publicName: 'Dr Synthetic',
      bio: 'Synthetic public professional biography.',
      specialtyIds: [String(specialty._id)],
    }),
    key(),
  );
  const qualification = await practitioners.addCredential(
    doctorAccount.actor,
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
    doctorAccount.actor,
    'registrations',
    practitionerDto.professionalRegistrationInput.parse({
      authority: 'Synthetic test council',
      jurisdiction: 'WB',
      registrationNumberNormalized: key(),
      issuedOn: '2010-01-01',
      expiresOn: todayInIndia(new Date(Date.now() + 120 * 86400_000)),
      evidenceReference: 'secret-registration-evidence',
    }),
    key(),
  );
  const draft = await practitioners.getDoctor(doctorAccount.actor);
  const review = await verification.submitDoctorVerification(
    doctorAccount.actor,
    {
      expectedVersion: draft.version,
      registrationId: registration.id,
      qualificationIds: [qualification.id],
      declaration: 'Synthetic accurate credentials declaration.',
    },
    key(),
  );
  await verification.decideDoctorVerification(
    reviewer.actor,
    review.id,
    {
      expectedVersion: 0,
      decision: 'APPROVED',
      reason: 'Independent synthetic review of identity and credentials.',
      checks: { identityChecked: true, registrationChecked: true, qualificationsChecked: true },
      validUntil: new Date(Date.now() + 100 * 86400_000).toISOString(),
    },
    key(),
  );
  await staff(owner, doctorAccount, clinic.organizationId, clinic.facilityId, 'clinician');
  const affiliation = await affiliations.inviteAffiliation(
    owner.actor,
    clinic.organizationId,
    {
      doctorId: doctor.id,
      facilityId: clinic.facilityId,
      title: 'Consultant',
      department: 'General medicine',
    },
    key(),
  );
  await affiliations.respondToAffiliation(
    doctorAccount.actor,
    affiliation.id,
    { expectedVersion: 0, decision: 'ACCEPT' },
    key(),
  );
  const current = await practitioners.getDoctor(doctorAccount.actor);
  await affiliations.publishDoctor(
    doctorAccount.actor,
    { expectedVersion: current.version, published: true },
    key(),
  );
  return {
    doctorId: doctor.id,
    practitionerId: practitioner.id,
    registrationId: registration.id,
    affiliationId: affiliation.id,
  };
}

/** An active offering with a published price and a daily schedule (IST 09:00–18:00). */
export async function bookableOffering(
  owner: Identity,
  clinic: { organizationId: string },
  affiliationId: string,
  options: {
    paymentPolicy?: 'PAY_AT_PROVIDER' | 'PREPAY' | 'FREE';
    amountMinor?: number;
    taxBasisPoints?: number;
  } = {},
) {
  const paymentPolicy = options.paymentPolicy ?? 'PAY_AT_PROVIDER';
  const offering = await scheduling.createOffering(
    owner.actor,
    clinic.organizationId,
    schedulingDto.offeringInput.parse({
      doctorAffiliationId: affiliationId,
      name: 'General consultation',
      mode: 'IN_PERSON',
      durationMinutes: 30,
      paymentPolicy,
      cancellationPolicy: { noticeHours: 24, refundBeforeBps: 10_000, refundAfterBps: 5_000 },
    }),
    key(),
  );
  const priced = await scheduling.publishPrice(
    owner.actor,
    clinic.organizationId,
    offering.id,
    schedulingDto.priceInput.parse({
      expectedVersion: offering.version,
      amountMinor: paymentPolicy === 'FREE' ? 0 : (options.amountMinor ?? 50_000),
      taxBasisPoints: options.taxBasisPoints ?? 0,
    }),
    key(),
  );
  const active = await scheduling.changeOfferingState(
    owner.actor,
    clinic.organizationId,
    offering.id,
    { expectedVersion: priced.version, status: 'ACTIVE', reason: 'Open bookings' },
    key(),
  );
  await scheduling.createSchedule(
    owner.actor,
    clinic.organizationId,
    schedulingDto.scheduleInput.parse({
      offeringId: offering.id,
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      startMinute: 540,
      endMinute: 1080,
      stepMinutes: 30,
      effectiveFrom: todayInIndia(),
      effectiveUntil: todayInIndia(new Date(Date.now() + 60 * 86400_000)),
    }),
    key(),
  );
  const quote = await scheduling.getPublicOffering(offering.id);
  return { offeringId: offering.id, version: active.version, priceId: quote.price.id, quote };
}

/** An IST slot start `days` from today at `minute` past midnight. */
export const slot = (days: number, minute = 600) =>
  atIndiaMinute(todayInIndia(new Date(Date.now() + days * 86400_000)), minute).toISOString();

export async function patient(identity: Identity, name = 'Synthetic Patient') {
  return patients.createPatient(
    identity.actor,
    createPatientInput.parse({
      kind: 'SELF',
      profile: {
        name: { display: name },
        birthDate: '1990-05-01',
        administrativeSex: 'FEMALE',
        addresses: [],
        contacts: [],
        emergencyContacts: [],
      },
    }),
    key(),
  );
}
