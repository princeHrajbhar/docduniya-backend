import type { ClientSession } from 'mongoose';
import type { CommandActor } from '../../shared/domain/healthcare.js';
import { todayInIndia } from '../../shared/domain/healthcare.js';
import { ApiError } from '../../utils/api-error.js';
import {
  Practitioner,
  Doctor,
  ProfessionalRegistration,
  PractitionerQualification,
  Specialty,
} from '../practitioners/practitioner.model.js';
import { User } from '../admin/auth/models/user.model.js';
import { Membership } from '../access/access.model.js';
import { DoctorVerificationCase, DoctorAffiliation } from './provider.model.js';
import { Facility, Organization } from '../organizations/organization.model.js';
import { authorizeOrganization, lockMembership } from '../access/access.service.js';
import { lockActiveFacility } from '../organizations/organization.repository.js';

export async function ownDoctor(actor: CommandActor, session?: ClientSession) {
  const practitioner = await Practitioner.findOne({
    userId: actor.userId,
    profession: 'DOCTOR',
    status: 'ACTIVE',
  }).session(session ?? null);
  if (!practitioner) throw ApiError.notFound('Doctor profile is unavailable');
  const doctor = await Doctor.findOne({ practitionerId: practitioner._id }).session(
    session ?? null,
  );
  if (!doctor) throw ApiError.notFound('Doctor profile is unavailable');
  return { doctor, practitioner };
}

export async function independentDoctorReviewer(
  actor: CommandActor,
  subjectUserId: string,
  session: ClientSession,
): Promise<void> {
  if (subjectUserId === actor.userId)
    throw ApiError.forbidden('An independent reviewer is required');
  const memberships = await Membership.find({
    userId: subjectUserId,
    status: { $in: ['ACTIVE', 'SUSPENDED'] },
  })
    .select('organizationId')
    .session(session)
    .lean();
  if (
    await Membership.exists({
      userId: actor.userId,
      organizationId: { $in: memberships.map((v) => v.organizationId) },
      status: { $in: ['ACTIVE', 'SUSPENDED'] },
    }).session(session)
  ) {
    throw ApiError.forbidden('A colleague at the same provider cannot perform this review');
  }
}

/** Authoritative eligibility; public projections must never bypass these checks. */
export async function verifiedDoctor(doctorId: string, session?: ClientSession) {
  const now = new Date();
  const today = todayInIndia(now);
  const doctor = await Doctor.findOne({
    _id: doctorId,
    verificationStatus: 'VERIFIED',
    verifiedUntil: { $gt: now },
  }).session(session ?? null);
  if (!doctor) throw ApiError.notFound('Verified doctor is unavailable');
  const practitioner = await Practitioner.findOne({
    _id: doctor.practitionerId,
    status: 'ACTIVE',
    profession: 'DOCTOR',
  }).session(session ?? null);
  if (
    !practitioner ||
    !(await User.exists({ _id: practitioner.userId, isActive: true, isVerified: true }).session(
      session ?? null,
    ))
  )
    throw ApiError.notFound('Verified doctor is unavailable');
  const review = await DoctorVerificationCase.findOne({
    _id: doctor.verificationCaseId,
    doctorId,
    status: 'APPROVED',
    validUntil: { $gt: now },
  }).session(session ?? null);
  if (!review) throw ApiError.notFound('Current credential review is unavailable');
  const registration = await ProfessionalRegistration.findOne({
    _id: review.registrationSnapshot.id,
    practitionerId: practitioner._id,
    verificationCaseId: review._id,
    status: 'VERIFIED',
    $and: [
      { $or: [{ issuedOn: { $exists: false } }, { issuedOn: { $lte: today } }] },
      { $or: [{ expiresOn: { $exists: false } }, { expiresOn: { $gte: today } }] },
    ],
  }).session(session ?? null);
  const qualificationCount = await PractitionerQualification.countDocuments({
    _id: { $in: review.qualificationSnapshots.map((v) => v.id) },
    practitionerId: practitioner._id,
    verificationCaseId: review._id,
    status: 'VERIFIED',
  }).session(session ?? null);
  const specialties = await Specialty.find({ _id: { $in: doctor.specialtyIds }, status: 'ACTIVE' })
    .select('code name')
    .session(session ?? null)
    .lean();
  if (
    !registration ||
    qualificationCount !== review.qualificationSnapshots.length ||
    !specialties.length ||
    specialties.length !== doctor.specialtyIds.length
  )
    throw ApiError.notFound('Current verified credentials are unavailable');
  return { doctor, practitioner, review, specialties };
}

export async function eligibleAffiliation(
  affiliationId: string,
  session?: ClientSession,
  options: { published?: boolean; lock?: boolean } = {},
) {
  const now = new Date();
  const affiliation = await DoctorAffiliation.findOne({
    _id: affiliationId,
    status: 'ACTIVE',
    validFrom: { $lte: now },
    $or: [{ validUntil: { $exists: false } }, { validUntil: { $gt: now } }],
  }).session(session ?? null);
  if (!affiliation) throw ApiError.notFound('Active affiliation is unavailable');
  const eligibility = await verifiedDoctor(String(affiliation.doctorId), session);
  if (options.published !== false && !eligibility.doctor.profilePublished)
    throw ApiError.notFound('Published doctor is unavailable');
  const organizationId = String(affiliation.organizationId);
  const facilityId = String(affiliation.facilityId);
  const scope = await authorizeOrganization(
    { userId: String(eligibility.practitioner.userId), requestId: 'eligibility-check' },
    organizationId,
    'affiliations.accept',
    { facilityId, activeProvider: true, session },
  );
  if (
    String(scope.membership._id) !== String(affiliation.membershipId) ||
    scope.membership.validFrom.getTime() !== affiliation.membershipValidFrom?.getTime()
  )
    throw ApiError.notFound('Current affiliation authority is unavailable');
  const facility = await Facility.findOne({
    _id: facilityId,
    organizationId,
    status: 'ACTIVE',
  }).session(session ?? null);
  if (!facility) throw ApiError.notFound('Active facility is unavailable');
  if (options.lock && session) {
    await lockMembership(scope.membership._id, session);
    await lockActiveFacility(organizationId, facilityId, session);
    await Organization.updateOne(
      { _id: organizationId, status: 'ACTIVE' },
      { $inc: { authorizationFence: 1 } },
      { session },
    );
    await Doctor.updateOne(
      { _id: eligibility.doctor._id },
      { $inc: { authorizationFence: 1 } },
      { session },
    );
    await DoctorAffiliation.updateOne(
      { _id: affiliation._id },
      { $inc: { authorizationFence: 1 } },
      { session },
    );
  }
  return { ...eligibility, ...scope, affiliation, facility };
}
