import type { ClientSession } from 'mongoose';
import type { CommandActor } from '../../shared/domain/healthcare.js';
import { scoped } from '../../shared/application/scope.js';
import { ApiError } from '../../utils/api-error.js';
import type { OrgPermission } from '../access/access.constants.js';
import { authorizeOrganization } from '../access/access.service.js';
import { PatientRegistration } from '../patients/patient.model.js';
import { Practitioner } from '../practitioners/practitioner.model.js';
import { DoctorAffiliation } from '../providers/provider.model.js';
import { eligibleAffiliation } from '../providers/provider.policy.js';
import { activeGrant } from '../privacy/grant.service.js';
import { CareTeamAssignment } from './clinical.model.js';

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

/**
 * Clinical access = organization permission + facility scope + local registration + a current
 * care relationship (care-team assignment or reviewed emergency access). Administration and
 * platform roles never satisfy it. Unrelated charts are reported as not found.
 */
export async function authorizeClinical(
  actor: CommandActor,
  organizationId: string,
  patientId: string,
  permission: OrgPermission,
  options: { session?: ClientSession; facilityId?: string; requireCare?: boolean } = {},
) {
  const { session } = options;
  const scope = session
    ? await scoped(actor, organizationId, permission, session, {
        facilityId: options.facilityId,
        activeProvider: true,
      })
    : await authorizeOrganization(actor, organizationId, permission, {
        facilityId: options.facilityId,
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
    const care = await CareTeamAssignment.exists({
      organizationId,
      patientId,
      userId: actor.userId,
      status: 'ACTIVE',
    }).session(session ?? null);
    if (care) basis = 'CARE_TEAM';
    else {
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
  return { scope, registration, practitioner, basis };
}

/**
 * Prescribing privilege: the actor is a currently verified doctor with an eligible accepted
 * affiliation at the facility. A suspended or expired credential blocks new prescriptions.
 */
export async function verifiedPrescriber(
  actor: CommandActor,
  organizationId: string,
  facilityId: string,
  session: ClientSession,
) {
  const practitioner = await ownPractitioner(actor, session, ['DOCTOR']);
  const affiliations = await DoctorAffiliation.find({
    organizationId,
    facilityId,
    status: 'ACTIVE',
  }).session(session);
  for (const affiliation of affiliations) {
    try {
      const eligibility = await eligibleAffiliation(String(affiliation._id), session, {
        published: false,
        lock: true,
      });
      if (String(eligibility.practitioner._id) === String(practitioner._id)) return eligibility;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
    }
  }
  throw new ApiError(
    403,
    'A current verified credential and affiliation are required',
    undefined,
    'CREDENTIAL_INVALID',
  );
}
