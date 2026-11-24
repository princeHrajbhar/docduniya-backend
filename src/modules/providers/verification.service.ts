import { Types } from 'mongoose';
import type { z } from 'zod';
import type { CommandActor, Pagination } from '../../shared/domain/healthcare.js';
import { todayInIndia } from '../../shared/domain/healthcare.js';
import { command, conflict } from '../../shared/application/command.js';
import { stamp } from '../../shared/persistence/schema.js';
import { ApiError } from '../../utils/api-error.js';
import { recordChange, recordRead } from '../operations/operation.service.js';
import { requirePlatformPermission } from '../access/platform-access.js';
import { PERMISSIONS } from '../admin/auth/roles/permission.constants.js';
import {
  Doctor,
  Practitioner,
  PractitionerQualification,
  ProfessionalRegistration,
  Specialty,
} from '../practitioners/practitioner.model.js';
import { DoctorVerificationCase } from './provider.model.js';
import { ownDoctor, independentDoctorReviewer } from './provider.policy.js';
import type {
  verificationSubmission,
  verificationDecision,
  withdrawVerificationInput,
  doctorRestrictionInput,
} from './provider.validation.js';

export async function submitDoctorVerification(
  actor: CommandActor,
  input: z.infer<typeof verificationSubmission>,
  key: string,
) {
  return command(actor, 'self', 'doctor.verification.submit', key, input, async (session) => {
    const { doctor, practitioner } = await ownDoctor(actor, session);
    if (doctor.version !== input.expectedVersion || doctor.verificationStatus !== 'UNVERIFIED')
      conflict('Withdraw the existing verification before submitting a new draft');
    const today = todayInIndia();
    const registration = await ProfessionalRegistration.findOne({
      _id: input.registrationId,
      practitionerId: practitioner._id,
      status: { $in: ['DECLARED', 'VERIFIED'] },
    }).session(session);
    if (
      !registration ||
      (registration.issuedOn && registration.issuedOn > today) ||
      (registration.expiresOn && registration.expiresOn < today)
    )
      throw ApiError.badRequest('Choose your own current registration declaration');
    const qualifications = await PractitionerQualification.find({
      _id: { $in: input.qualificationIds },
      practitionerId: practitioner._id,
      status: { $in: ['DECLARED', 'VERIFIED'] },
    }).session(session);
    if (qualifications.length !== input.qualificationIds.length || !qualifications.length)
      throw ApiError.badRequest('Choose your own current qualification declarations');
    const specialtyCount = await Specialty.countDocuments({
      _id: { $in: doctor.specialtyIds },
      status: 'ACTIVE',
    }).session(session);
    if (!specialtyCount || specialtyCount !== doctor.specialtyIds.length)
      throw ApiError.badRequest('Choose active specialties before submitting');
    const [review] = await DoctorVerificationCase.create(
      [
        {
          ...stamp(actor.userId),
          doctorId: doctor._id,
          practitionerId: practitioner._id,
          submittedBy: actor.userId,
          identitySnapshot: { name: practitioner.name, birthDate: practitioner.birthDate },
          profileSnapshot: {
            publicName: doctor.publicName,
            bio: doctor.bio,
            specialtyIds: doctor.specialtyIds,
          },
          registrationSnapshot: {
            id: registration._id,
            version: registration.version,
            authority: registration.authority,
            jurisdiction: registration.jurisdiction,
            registrationNumberNormalized: registration.registrationNumberNormalized,
            issuedOn: registration.issuedOn,
            expiresOn: registration.expiresOn,
            evidenceReference: registration.evidenceReference,
          },
          qualificationSnapshots: qualifications.map((v) => ({
            id: v._id,
            version: v.version,
            kind: v.kind,
            qualificationName: v.qualificationName,
            institutionName: v.institutionName,
            awardYear: v.awardYear,
            completionDate: v.completionDate,
            certificateNumber: v.certificateNumber,
            evidenceReference: v.evidenceReference,
          })),
          declaration: input.declaration,
        },
      ],
      { session },
    );
    doctor.verificationStatus = 'IN_REVIEW';
    doctor.profilePublished = false;
    doctor.verifiedUntil = undefined;
    doctor.updatedBy = { kind: 'USER', id: actor.userId };
    await doctor.save({ session });
    const id = String(review!._id);
    await recordChange(
      actor,
      {
        action: 'DoctorVerificationSubmitted',
        resourceType: 'doctorVerificationCase',
        resourceId: id,
        version: 0,
      },
      session,
    );
    await recordChange(
      actor,
      {
        action: 'DoctorReviewStarted',
        resourceType: 'doctor',
        resourceId: String(doctor._id),
        version: doctor.version,
      },
      session,
    );
    return { id, version: 0 };
  });
}

export async function decideDoctorVerification(
  actor: CommandActor,
  reviewId: string,
  input: z.infer<typeof verificationDecision>,
  key: string,
) {
  await requirePlatformPermission(actor, PERMISSIONS.DOCTORS_VERIFY);
  return command(
    actor,
    'platform',
    `doctor.verification.decide:${reviewId}`,
    key,
    input,
    async (session) => {
      const review = await DoctorVerificationCase.findOne({
        _id: reviewId,
        status: 'SUBMITTED',
        version: input.expectedVersion,
      }).session(session);
      if (!review) conflict('The review is no longer pending');
      await independentDoctorReviewer(actor, String(review.submittedBy), session);
      const doctor = await Doctor.findOne({
        _id: review.doctorId,
        practitionerId: review.practitionerId,
        verificationStatus: 'IN_REVIEW',
      }).session(session);
      const practitioner = await Practitioner.findOne({
        _id: review.practitionerId,
        status: 'ACTIVE',
      }).session(session);
      if (!doctor || !practitioner) conflict('The applicant is no longer eligible for this review');
      let validUntil: Date | undefined;
      if (input.decision === 'APPROVED') {
        const now = new Date();
        validUntil = input.validUntil ? new Date(input.validUntil) : undefined;
        if (
          !validUntil ||
          validUntil <= now ||
          validUntil.getTime() > now.getTime() + 366 * 86400_000 ||
          !input.checks
        )
          throw ApiError.badRequest(
            'Approval requires completed checks and an expiry within the next year',
          );
        const source = review.registrationSnapshot;
        if (source.issuedOn && source.issuedOn > todayInIndia(now))
          throw ApiError.badRequest('The registration has not taken effect');
        if (source.expiresOn && validUntil > new Date(`${source.expiresOn}T23:59:59.999+05:30`))
          throw ApiError.badRequest('Verification cannot outlive the registration');
        const registration = await ProfessionalRegistration.findOne({
          _id: source.id,
          practitionerId: review.practitionerId,
          version: source.version,
          status: { $in: ['DECLARED', 'VERIFIED'] },
        }).session(session);
        if (!registration) conflict('The registration declaration changed');
        registration.status = 'VERIFIED';
        registration.verificationCaseId = review._id;
        registration.lastVerifiedAt = now;
        registration.updatedBy = { kind: 'USER', id: actor.userId };
        await registration.save({ session });
        await recordChange(
          actor,
          {
            action: 'ProfessionalRegistrationVerified',
            resourceType: 'professionalRegistration',
            resourceId: String(registration._id),
            version: registration.version,
          },
          session,
        );
        for (const sourceQualification of review.qualificationSnapshots) {
          const qualification = await PractitionerQualification.findOne({
            _id: sourceQualification.id,
            practitionerId: review.practitionerId,
            version: sourceQualification.version,
            status: { $in: ['DECLARED', 'VERIFIED'] },
          }).session(session);
          if (!qualification) conflict('A qualification declaration changed');
          qualification.status = 'VERIFIED';
          qualification.verificationCaseId = review._id;
          qualification.lastVerifiedAt = now;
          qualification.updatedBy = { kind: 'USER', id: actor.userId };
          await qualification.save({ session });
          await recordChange(
            actor,
            {
              action: 'QualificationVerified',
              resourceType: 'practitionerQualification',
              resourceId: String(qualification._id),
              version: qualification.version,
            },
            session,
          );
        }
        doctor.verificationCaseId = review._id;
      }
      review.status = input.decision;
      review.reason = input.reason;
      review.validUntil = validUntil;
      review.set('checks', input.checks);
      review.decisionAt = new Date();
      review.decisionBy = new Types.ObjectId(actor.userId);
      review.updatedBy = { kind: 'USER', id: actor.userId };
      await review.save({ session });
      doctor.verificationStatus = input.decision === 'APPROVED' ? 'VERIFIED' : 'UNVERIFIED';
      doctor.verifiedUntil = validUntil;
      doctor.profilePublished = false;
      doctor.updatedBy = { kind: 'USER', id: actor.userId };
      await doctor.save({ session });
      await recordChange(
        actor,
        {
          action: `DoctorVerification${input.decision}`,
          resourceType: 'doctorVerificationCase',
          resourceId: reviewId,
          version: review.version,
          reason: input.reason,
        },
        session,
      );
      await recordChange(
        actor,
        {
          action: 'DoctorVerificationStateChanged',
          resourceType: 'doctor',
          resourceId: String(doctor._id),
          version: doctor.version,
        },
        session,
      );
      return { id: reviewId, version: review.version };
    },
  );
}

export async function withdrawDoctorVerification(
  actor: CommandActor,
  input: z.infer<typeof withdrawVerificationInput>,
  key: string,
) {
  return command(actor, 'self', 'doctor.verification.withdraw', key, input, async (session) => {
    const { doctor } = await ownDoctor(actor, session);
    if (doctor.version !== input.expectedVersion || doctor.verificationStatus === 'SUSPENDED')
      conflict('A suspended doctor requires platform review');
    const pending = await DoctorVerificationCase.findOne({
      doctorId: doctor._id,
      status: 'SUBMITTED',
    }).session(session);
    if (pending) {
      pending.status = 'WITHDRAWN';
      pending.reason = input.reason;
      pending.updatedBy = { kind: 'USER', id: actor.userId };
      await pending.save({ session });
      await recordChange(
        actor,
        {
          action: 'DoctorVerificationWithdrawn',
          resourceType: 'doctorVerificationCase',
          resourceId: String(pending._id),
          version: pending.version,
          reason: input.reason,
        },
        session,
      );
    }
    doctor.verificationStatus = 'UNVERIFIED';
    doctor.profilePublished = false;
    doctor.verifiedUntil = undefined;
    doctor.verificationCaseId = undefined;
    doctor.updatedBy = { kind: 'USER', id: actor.userId };
    await doctor.save({ session });
    await recordChange(
      actor,
      {
        action: 'DoctorReturnedToDraft',
        resourceType: 'doctor',
        resourceId: String(doctor._id),
        version: doctor.version,
        reason: input.reason,
      },
      session,
    );
    return { id: String(doctor._id), version: doctor.version };
  });
}

export async function restrictDoctor(
  actor: CommandActor,
  doctorId: string,
  input: z.infer<typeof doctorRestrictionInput>,
  key: string,
) {
  await requirePlatformPermission(actor, PERMISSIONS.DOCTORS_VERIFY);
  return command(actor, 'platform', `doctor.restrict:${doctorId}`, key, input, async (session) => {
    const doctor = await Doctor.findOne({ _id: doctorId, version: input.expectedVersion }).session(
      session,
    );
    if (!doctor) conflict();
    const practitioner = await Practitioner.findById(doctor.practitionerId).session(session);
    if (!practitioner) throw ApiError.notFound();
    await independentDoctorReviewer(actor, String(practitioner.userId), session);
    if (input.status === 'UNVERIFIED' && doctor.verificationStatus !== 'SUSPENDED')
      conflict('Only a suspension may be lifted through this action');
    const pending = await DoctorVerificationCase.findOne({ doctorId, status: 'SUBMITTED' }).session(
      session,
    );
    if (pending) {
      pending.status = 'WITHDRAWN';
      pending.reason = input.reason;
      pending.decisionBy = new Types.ObjectId(actor.userId);
      pending.decisionAt = new Date();
      pending.updatedBy = { kind: 'USER', id: actor.userId };
      await pending.save({ session });
      await recordChange(
        actor,
        {
          action: 'DoctorReviewClosedByRestriction',
          resourceType: 'doctorVerificationCase',
          resourceId: String(pending._id),
          version: pending.version,
          reason: input.reason,
        },
        session,
      );
    }
    doctor.verificationStatus = input.status;
    doctor.profilePublished = false;
    doctor.verifiedUntil = undefined;
    doctor.updatedBy = { kind: 'USER', id: actor.userId };
    await doctor.save({ session });
    await recordChange(
      actor,
      {
        action: 'DoctorRestrictionChanged',
        resourceType: 'doctor',
        resourceId: doctorId,
        version: doctor.version,
        reason: input.reason,
      },
      session,
    );
    return { id: doctorId, version: doctor.version };
  });
}

export async function listDoctorVerifications(
  actor: CommandActor,
  page: Pagination,
  platform = false,
) {
  if (platform) await requirePlatformPermission(actor, PERMISSIONS.DOCTORS_VERIFY);
  const rows = await DoctorVerificationCase.find({
    ...(platform ? { status: 'SUBMITTED' } : { submittedBy: actor.userId }),
    ...(page.before ? { _id: { $lt: new Types.ObjectId(page.before) } } : {}),
  })
    .select('doctorId status createdAt decisionAt validUntil version reason')
    .sort({ _id: -1 })
    .limit(page.limit + 1)
    .lean();
  for (const row of rows.slice(0, page.limit))
    await recordRead(actor, 'doctorVerificationCase', String(row._id));
  return {
    items: rows.slice(0, page.limit).map(({ _id, ...row }) => ({ id: String(_id), ...row })),
    nextCursor: rows.length > page.limit ? String(rows[page.limit - 1]!._id) : undefined,
  };
}

export async function getDoctorVerification(
  actor: CommandActor,
  reviewId: string,
  platform = false,
) {
  if (platform) await requirePlatformPermission(actor, PERMISSIONS.DOCTORS_VERIFY);
  const review = await DoctorVerificationCase.findOne({
    _id: reviewId,
    ...(!platform ? { submittedBy: actor.userId } : {}),
  }).lean();
  if (!review) throw ApiError.notFound();
  await recordRead(actor, 'doctorVerificationCase', reviewId);
  const { _id, ...row } = review;
  return { id: String(_id), ...row };
}
