import type { ClientSession } from 'mongoose';
import type { CommandActor } from '../../shared/domain/healthcare.js';
import { scoped, facilityFilter } from '../../shared/application/scope.js';
import { ApiError } from '../../utils/api-error.js';
import type { OrgPermission } from '../access/access.constants.js';
import { authorizeOrganization } from '../access/access.service.js';
import { PatientRegistration } from '../patients/patient.model.js';
import { Doctor, Practitioner } from '../practitioners/practitioner.model.js';
import { DoctorAffiliation } from '../providers/provider.model.js';
import { eligibleAffiliation } from '../providers/provider.policy.js';
import { activeGrant } from '../privacy/grant.service.js';
import { currentProfessionalCredential } from '../practitioners/credential.service.js';
import { CareTeamAssignment, Encounter } from './clinical.model.js';

type Profession = 'DOCTOR' | 'NURSE' | 'PHARMACIST' | 'THERAPIST' | 'LAB_PROFESSIONAL' | 'OTHER';

export async function ownPractitioner(
  actor: CommandActor,
  session?: ClientSession,
  professions?: Profession[],
) {
  const practitioner = await Practitioner.findOne({
    userId: actor.userId,
    status: 'ACTIVE',
    ...(professions ? { profession: { $in: professions } } : {}),
  }).session(session ?? null);
  if (!practitioner) throw ApiError.forbidden('An active professional profile is required');
  return practitioner;
}

/** Where a record lives: its own facility, its encounter's facility, or the registration's. */
type RecordCustody = { facilityId?: unknown; encounterId?: unknown };

async function custodyFacility(
  organizationId: string,
  patientId: string,
  record: RecordCustody,
  session?: ClientSession,
) {
  if (record.facilityId) return String(record.facilityId);
  if (record.encounterId) {
    const encounter = await Encounter.findOne({
      _id: record.encounterId,
      organizationId,
      patientId,
    }).session(session ?? null);
    if (!encounter) throw ApiError.notFound('Record custody is unavailable');
    return String(encounter.facilityId);
  }
  const registration = await PatientRegistration.findOne({
    organizationId,
    patientId,
    status: 'ACTIVE',
  }).session(session ?? null);
  if (!registration) throw ApiError.notFound('Patient chart is unavailable');
  return String(registration.primaryFacilityId);
}

/**
 * Clinical access = organization permission + facility scope + local registration + a current
 * care relationship (care-team assignment or reviewed emergency access) + for signing, a current
 * professional credential. Administration and platform roles never satisfy it. Unrelated charts
 * are reported as not found.
 *
 * Facility rule: a member restricted to selected facilities reaches only records held at those
 * facilities, through individual and aggregate reads alike (`chartFilter`). Organization-wide
 * members see the organization's longitudinal chart. Care relationships are honoured only when
 * they were created under the member's current membership.
 */
export async function authorizeClinical(
  actor: CommandActor,
  organizationId: string,
  patientId: string,
  permission: OrgPermission,
  options: {
    session?: ClientSession;
    facilityId?: string;
    requireCare?: boolean;
    record?: RecordCustody;
  } = {},
) {
  const { session } = options;
  const facilityId = options.record
    ? await custodyFacility(organizationId, patientId, options.record, session)
    : options.facilityId;
  const scope = session
    ? await scoped(actor, organizationId, permission, session, {
        facilityId,
        activeProvider: true,
      })
    : await authorizeOrganization(actor, organizationId, permission, {
        facilityId,
        activeProvider: true,
      });
  const registration = await PatientRegistration.findOne({
    organizationId,
    patientId,
    status: 'ACTIVE',
  }).session(session ?? null);
  if (!registration) throw ApiError.notFound('Patient chart is unavailable');
  const practitioner = await ownPractitioner(actor, session);
  let basis: 'CARE_TEAM' | 'EMERGENCY' | 'NEW_ENCOUNTER' = 'NEW_ENCOUNTER';
  if (options.requireCare !== false) {
    const now = new Date();
    const care = await CareTeamAssignment.findOne({
      organizationId,
      patientId,
      userId: actor.userId,
      status: 'ACTIVE',
      membershipValidFrom: scope.membership.validFrom,
      periodStart: { $lte: now },
      $or: [{ periodEnd: { $exists: false } }, { periodEnd: { $gt: now } }],
      ...facilityFilter(scope.membership),
    }).session(session ?? null);
    if (care) {
      basis = 'CARE_TEAM';
      // Serializes a write that relies on this relationship with a concurrent end of care.
      if (session)
        await CareTeamAssignment.updateOne(
          { _id: care._id },
          { $inc: { authorizationFence: 1 } },
          { session },
        );
    } else {
      const emergency = await activeGrant(
        patientId,
        { userId: actor.userId },
        'encounters',
        session,
      );
      if (
        !emergency ||
        emergency.basis !== 'EMERGENCY' ||
        String(emergency.organizationId) !== organizationId
      )
        throw ApiError.notFound('Patient chart is unavailable');
      basis = 'EMERGENCY';
    }
  }
  const custody = facilityId ?? String(registration.primaryFacilityId);
  if (permission === 'clinical.sign')
    await currentClinicalCredential(actor, organizationId, custody, session);
  return { scope, registration, practitioner, basis, facilityId: custody };
}

/** Facility restriction for aggregate chart reads; identical to the individual-record rule. */
export function chartFilter(
  access: Awaited<ReturnType<typeof authorizeClinical>>,
  organizationId: string,
  patientId: string,
) {
  return { organizationId, patientId, ...facilityFilter(access.scope.membership) };
}

/**
 * Signing privilege for every profession: doctors need a current verified registration and an
 * eligible affiliation at the facility; other professions need an approved, unexpired
 * credential. Suspension or expiry blocks new signatures immediately.
 */
export async function currentClinicalCredential(
  actor: CommandActor,
  organizationId: string,
  facilityId: string,
  session?: ClientSession,
) {
  const practitioner = await ownPractitioner(actor, session);
  if (practitioner.profession === 'DOCTOR')
    return verifiedPrescriber(actor, organizationId, facilityId, session);
  return currentProfessionalCredential(practitioner, session);
}

/**
 * Prescribing privilege: the actor is a currently verified doctor with an eligible accepted
 * affiliation at the facility. A suspended or expired credential blocks new prescriptions.
 */
export async function verifiedPrescriber(
  actor: CommandActor,
  organizationId: string,
  facilityId: string,
  session?: ClientSession,
) {
  const practitioner = await ownPractitioner(actor, session, ['DOCTOR']);
  const doctor = await Doctor.findOne({ practitionerId: practitioner._id }).session(
    session ?? null,
  );
  if (!doctor) throw credentialInvalid();
  const affiliations = await DoctorAffiliation.find({
    organizationId,
    facilityId,
    doctorId: doctor._id,
    status: 'ACTIVE',
  }).session(session ?? null);
  for (const affiliation of affiliations) {
    try {
      const eligibility = await eligibleAffiliation(String(affiliation._id), session, {
        published: false,
        lock: Boolean(session),
      });
      if (String(eligibility.practitioner._id) === String(practitioner._id)) return eligibility;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
    }
  }
  throw credentialInvalid();
}

const credentialInvalid = () =>
  new ApiError(
    403,
    'A current verified credential and affiliation are required',
    undefined,
    'CREDENTIAL_INVALID',
  );
