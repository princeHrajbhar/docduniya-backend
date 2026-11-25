import { Types, type ClientSession } from 'mongoose';
import { z } from 'zod';
import type { CommandActor } from '../../shared/domain/healthcare.js';
import { objectId, todayInIndia } from '../../shared/domain/healthcare.js';
import { command, conflict } from '../../shared/application/command.js';
import {
  actorRef,
  before,
  pageOf,
  presentRow,
  type OperationActor,
} from '../../shared/application/scope.js';
import { stamp } from '../../shared/persistence/schema.js';
import { ApiError } from '../../utils/api-error.js';
import { requirePlatformPermission } from '../access/platform-access.js';
import { PERMISSIONS } from '../admin/auth/roles/permission.constants.js';
import { recordChange } from '../operations/operation.service.js';
import { independentDoctorReviewer } from '../providers/provider.policy.js';
import { ProfessionalCredentialReview } from './credential.model.js';
import { Practitioner, ProfessionalRegistration } from './practitioner.model.js';

const version = z.number().int().min(0);
const reason = z.string().trim().min(20).max(1000);

export const credentialSubmission = z.strictObject({
  registrationId: objectId,
  declaration: z.string().trim().min(20).max(1000),
});
export const credentialDecision = z
  .strictObject({
    expectedVersion: version,
    decision: z.enum(['APPROVED', 'REJECTED']),
    reason,
    validUntil: z.iso.datetime().optional(),
    checks: z
      .strictObject({ identityChecked: z.literal(true), registrationChecked: z.literal(true) })
      .optional(),
  })
  .refine((v) => v.decision !== 'APPROVED' || (v.validUntil && v.checks), {
    message: 'Approval requires completed checks and an expiry',
  });
export const credentialRestriction = z.strictObject({ expectedVersion: version, reason });
export const credentialQuery = z.strictObject({
  status: z
    .enum(['SUBMITTED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'SUSPENDED', 'EXPIRED'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  before: objectId.optional(),
});

const NON_DOCTOR = ['NURSE', 'PHARMACIST', 'THERAPIST', 'LAB_PROFESSIONAL', 'OTHER'] as const;
type PractitionerRow = Awaited<ReturnType<typeof Practitioner.findOne>>;

/**
 * The privilege check used by signing, dispensing, result verification and medication
 * administration for non-doctor professionals. Doctors use their verification case instead.
 */
export async function currentProfessionalCredential(
  practitioner: NonNullable<PractitionerRow>,
  session?: ClientSession,
) {
  if (practitioner.profession === 'DOCTOR')
    throw ApiError.forbidden('Doctors are checked through doctor verification');
  const now = new Date();
  const review = await ProfessionalCredentialReview.findOne({
    practitionerId: practitioner._id,
    status: 'APPROVED',
    validUntil: { $gt: now },
  }).session(session ?? null);
  const registration = review
    ? await ProfessionalRegistration.findOne({
        _id: review.registrationSnapshot.id,
        practitionerId: practitioner._id,
        status: 'VERIFIED',
      }).session(session ?? null)
    : null;
  const today = todayInIndia(now);
  if (!review || !registration || (registration.expiresOn && registration.expiresOn < today))
    throw new ApiError(
      403,
      'A current verified professional credential is required',
      undefined,
      'CREDENTIAL_INVALID',
    );
  return { review, registration, practitioner };
}

/** Requires the caller's own active professional profile of one of the given professions. */
export async function credentialedProfessional(
  actor: CommandActor,
  professions: ReadonlyArray<(typeof NON_DOCTOR)[number] | 'DOCTOR'>,
  session?: ClientSession,
) {
  const practitioner = await Practitioner.findOne({
    userId: actor.userId,
    status: 'ACTIVE',
    profession: { $in: professions },
  }).session(session ?? null);
  if (!practitioner) throw ApiError.forbidden('An active professional profile is required');
  if (practitioner.profession !== 'DOCTOR')
    await currentProfessionalCredential(practitioner, session);
  return practitioner;
}

export async function submitCredential(
  actor: CommandActor,
  input: z.infer<typeof credentialSubmission>,
  key: string,
) {
  return command(actor, 'self', 'professional.credential.submit', key, input, async (session) => {
    const practitioner = await Practitioner.findOne({
      userId: actor.userId,
      status: 'ACTIVE',
      profession: { $in: NON_DOCTOR },
    }).session(session);
    if (!practitioner)
      throw ApiError.forbidden('Only nurses, pharmacists and allied professionals use this review');
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
    if (
      await ProfessionalCredentialReview.exists({
        practitionerId: practitioner._id,
        status: 'SUBMITTED',
      }).session(session)
    )
      conflict('A credential review is already pending');
    const [review] = await ProfessionalCredentialReview.create(
      [
        {
          ...stamp(actor.userId),
          practitionerId: practitioner._id,
          profession: practitioner.profession as (typeof NON_DOCTOR)[number],
          submittedBy: actor.userId,
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
          declaration: input.declaration,
        },
      ],
      { session },
    );
    await recordChange(
      actor,
      {
        action: 'ProfessionalCredentialSubmitted',
        resourceType: 'professionalCredentialReview',
        resourceId: String(review!._id),
        version: 0,
      },
      session,
    );
    return { id: String(review!._id), version: 0 };
  });
}

/**
 * Independent platform decision. Approval verifies the exact registration version reviewed and
 * replaces any earlier approval (one current approval per professional).
 */
export async function decideCredential(
  actor: CommandActor,
  reviewId: string,
  input: z.infer<typeof credentialDecision>,
  key: string,
) {
  await requirePlatformPermission(actor, PERMISSIONS.PROFESSIONALS_VERIFY);
  return command(
    actor,
    'platform',
    `professional.credential.decide:${reviewId}`,
    key,
    input,
    async (session) => {
      const review = await ProfessionalCredentialReview.findOne({
        _id: reviewId,
        status: 'SUBMITTED',
        version: input.expectedVersion,
      }).session(session);
      if (!review) conflict('The review is no longer pending');
      await independentDoctorReviewer(actor, String(review.submittedBy), session);
      const now = new Date();
      if (input.decision === 'APPROVED') {
        const validUntil = new Date(input.validUntil!);
        if (validUntil <= now || validUntil.getTime() > now.getTime() + 366 * 86400_000)
          throw ApiError.badRequest('Approval expiry must fall within the next year');
        const source = review.registrationSnapshot;
        if (source.expiresOn && validUntil > new Date(`${source.expiresOn}T23:59:59.999+05:30`))
          throw ApiError.badRequest('Approval cannot outlive the registration');
        const registration = await ProfessionalRegistration.findOne({
          _id: source.id,
          practitionerId: review.practitionerId,
          version: source.version,
          status: { $in: ['DECLARED', 'VERIFIED'] },
        }).session(session);
        if (!registration) conflict('The registration declaration changed');
        registration.status = 'VERIFIED';
        registration.lastVerifiedAt = now;
        registration.updatedBy = { kind: 'USER', id: actor.userId };
        await registration.save({ session });
        await ProfessionalCredentialReview.updateMany(
          { practitionerId: review.practitionerId, status: 'APPROVED' },
          { $set: { status: 'EXPIRED', updatedBy: { kind: 'USER', id: actor.userId } } },
          { session },
        );
        review.validUntil = validUntil;
        review.checks = Object.keys(input.checks ?? {});
      }
      review.status = input.decision;
      review.reason = input.reason;
      review.reviewedBy = new Types.ObjectId(actor.userId);
      review.reviewedAt = now;
      review.updatedBy = { kind: 'USER', id: actor.userId };
      await review.save({ session });
      await recordChange(
        actor,
        {
          action: `ProfessionalCredential${input.decision === 'APPROVED' ? 'Approved' : 'Rejected'}`,
          resourceType: 'professionalCredentialReview',
          resourceId: reviewId,
          version: review.version,
          reason: input.reason,
        },
        session,
      );
      return { id: reviewId, version: review.version };
    },
  );
}

/** Suspends a current approval: the professional loses licensed privileges at once. */
export async function suspendCredential(
  actor: CommandActor,
  reviewId: string,
  input: z.infer<typeof credentialRestriction>,
  key: string,
) {
  await requirePlatformPermission(actor, PERMISSIONS.PROFESSIONALS_VERIFY);
  return command(
    actor,
    'platform',
    `professional.credential.suspend:${reviewId}`,
    key,
    input,
    async (session) => {
      const review = await ProfessionalCredentialReview.findOne({
        _id: reviewId,
        status: 'APPROVED',
        version: input.expectedVersion,
      }).session(session);
      if (!review) conflict();
      await independentDoctorReviewer(actor, String(review.submittedBy), session);
      review.status = 'SUSPENDED';
      review.reason = input.reason;
      review.updatedBy = { kind: 'USER', id: actor.userId };
      await review.save({ session });
      await recordChange(
        actor,
        {
          action: 'ProfessionalCredentialSuspended',
          resourceType: 'professionalCredentialReview',
          resourceId: reviewId,
          version: review.version,
          reason: input.reason,
        },
        session,
      );
      return { id: reviewId, version: review.version };
    },
  );
}

export async function myCredentialReviews(actor: CommandActor) {
  const practitioner = await Practitioner.findOne({ userId: actor.userId });
  if (!practitioner) return { items: [] };
  const rows = await ProfessionalCredentialReview.find({ practitionerId: practitioner._id })
    .sort({ _id: -1 })
    .limit(50)
    .lean();
  return { items: rows.map(presentRow) };
}

export async function listCredentialReviews(
  actor: CommandActor,
  query: z.infer<typeof credentialQuery>,
) {
  await requirePlatformPermission(actor, PERMISSIONS.PROFESSIONALS_VERIFY);
  const rows = await ProfessionalCredentialReview.find({
    ...(query.status ? { status: query.status } : {}),
    ...before(query.before),
  })
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean();
  return pageOf(rows, query.limit, presentRow);
}

/** Worker sweep: approvals past their expiry become EXPIRED. */
export async function expireCredentials(actor: OperationActor): Promise<number> {
  const result = await ProfessionalCredentialReview.updateMany(
    { status: 'APPROVED', validUntil: { $lte: new Date() } },
    { $set: { status: 'EXPIRED', updatedBy: actorRef(actor) }, $inc: { version: 1 } },
  );
  return result.modifiedCount;
}
