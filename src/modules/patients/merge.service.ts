import { Types } from 'mongoose';
import { z } from 'zod';
import type { CommandActor } from '../../shared/domain/healthcare.js';
import { objectId } from '../../shared/domain/healthcare.js';
import { command, conflict } from '../../shared/application/command.js';
import { before, pageOf, presentRow } from '../../shared/application/scope.js';
import { stamp } from '../../shared/persistence/schema.js';
import { ApiError } from '../../utils/api-error.js';
import { authorizeOrganization } from '../access/access.service.js';
import { requirePlatformPermission } from '../access/platform-access.js';
import { PERMISSIONS } from '../admin/auth/roles/permission.constants.js';
import { recordChange } from '../operations/operation.service.js';
import { authorizePatient } from './patient.service.js';
import { Patient, PatientMergeCase, PatientRegistration } from './patient.model.js';

export const mergeRequestInput = z
  .strictObject({
    sourcePatientId: objectId,
    targetPatientId: objectId,
    evidence: z.string().trim().min(20).max(2000),
  })
  .refine((v) => v.sourcePatientId !== v.targetPatientId, {
    message: 'Choose two different records',
  });
export const mergeDecisionInput = z.strictObject({
  expectedVersion: z.number().int().min(0),
  decision: z.enum(['APPROVED', 'REJECTED']),
  reason: z.string().trim().min(20).max(1000),
  checks: z
    .strictObject({ identityMatched: z.literal(true), noConflictingRecords: z.literal(true) })
    .optional(),
});
export const mergeQuery = z.strictObject({
  status: z.enum(['SUBMITTED', 'APPROVED', 'REJECTED', 'WITHDRAWN']).default('SUBMITTED'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  before: objectId.optional(),
});

/**
 * All identities whose records belong to this patient: the patient plus duplicates merged into
 * it. Patient-mediated reads (portal, export) span them; provider charts keep their own keys.
 */
export async function patientIdentityIds(patientId: string): Promise<Types.ObjectId[]> {
  const patient = await Patient.findById(patientId).select({ mergedPatientIds: 1 }).lean();
  return [new Types.ObjectId(patientId), ...(patient?.mergedPatientIds ?? [])];
}

/**
 * Either the surviving identity's owner (claiming a record a provider created for them) or a
 * provider holding both registrations requests a merge. Only unclaimed records merge: an account
 * owner's identity can never be absorbed into another account.
 */
export async function requestMerge(
  actor: CommandActor,
  input: z.infer<typeof mergeRequestInput>,
  key: string,
  organizationId?: string,
) {
  if (organizationId) await authorizeOrganization(actor, organizationId, 'patients.register');
  else await authorizePatient(actor, input.targetPatientId, 'profile.update');
  return command(
    actor,
    organizationId ?? 'self',
    `patient.merge:${input.sourcePatientId}`,
    key,
    input,
    async (session) => {
      const [source, target] = await Promise.all([
        Patient.findById(input.sourcePatientId).session(session),
        Patient.findById(input.targetPatientId).session(session),
      ]);
      if (!source || !target) throw ApiError.notFound('Patient is unavailable');
      if (source.ownerUserId)
        throw ApiError.badRequest('Records owned by an account cannot be merged into another');
      if (!['ACTIVE', 'TEMPORARY'].includes(source.status) || target.status !== 'ACTIVE')
        conflict('Only current records can be merged');
      if (organizationId) {
        const held = await PatientRegistration.countDocuments({
          organizationId,
          patientId: { $in: [source._id, target._id] },
          status: 'ACTIVE',
        }).session(session);
        if (held !== 2) throw ApiError.notFound('Both records must be registered with you');
      }
      const [row] = await PatientMergeCase.create(
        [
          {
            ...stamp(actor.userId),
            sourcePatientId: source._id,
            targetPatientId: target._id,
            requestedBy: actor.userId,
            requestedVia: organizationId ? 'PROVIDER' : 'PATIENT',
            organizationId,
            evidence: input.evidence,
          },
        ],
        { session },
      );
      await recordChange(
        actor,
        {
          organizationId,
          patientId: input.targetPatientId,
          action: 'PatientMergeRequested',
          resourceType: 'patientMergeCase',
          resourceId: String(row!._id),
          version: 0,
        },
        session,
      );
      return { id: String(row!._id), version: 0 };
    },
  );
}

/** Independent review; approval marks the duplicate MERGED and records it on the survivor. */
export async function decideMerge(
  actor: CommandActor,
  caseId: string,
  input: z.infer<typeof mergeDecisionInput>,
  key: string,
) {
  await requirePlatformPermission(actor, PERMISSIONS.PATIENT_IDENTITY_MANAGE);
  return command(
    actor,
    'platform',
    `patient.merge.decide:${caseId}`,
    key,
    input,
    async (session) => {
      const review = await PatientMergeCase.findOne({
        _id: caseId,
        status: 'SUBMITTED',
        version: input.expectedVersion,
      }).session(session);
      if (!review) conflict('The merge request is no longer pending');
      if (String(review.requestedBy) === actor.userId)
        throw ApiError.forbidden('An independent reviewer must decide merges');
      if (input.decision === 'APPROVED') {
        if (!input.checks) throw ApiError.badRequest('Approval requires completed identity checks');
        const source = await Patient.findOne({
          _id: review.sourcePatientId,
          status: { $in: ['ACTIVE', 'TEMPORARY'] },
          ownerUserId: { $exists: false },
        }).session(session);
        const target = await Patient.findOne({
          _id: review.targetPatientId,
          status: 'ACTIVE',
        }).session(session);
        if (!source || !target) conflict('The records changed since the request');
        source.status = 'MERGED';
        source.mergedIntoId = target._id;
        source.updatedBy = { kind: 'USER', id: actor.userId };
        source.authorizationFence += 1;
        await source.save({ session });
        target.mergedPatientIds = [
          ...new Set([
            ...target.mergedPatientIds.map(String),
            String(source._id),
            ...source.mergedPatientIds.map(String),
          ]),
        ].map((id) => new Types.ObjectId(id));
        target.updatedBy = { kind: 'USER', id: actor.userId };
        await target.save({ session });
        await recordChange(
          actor,
          {
            patientId: String(target._id),
            action: 'PatientIdentityMerged',
            resourceType: 'patient',
            resourceId: String(source._id),
            version: source.version,
            reason: input.reason,
          },
          session,
        );
      }
      review.status = input.decision;
      review.reason = input.reason;
      review.reviewedBy = new Types.ObjectId(actor.userId);
      review.decidedAt = new Date();
      review.updatedBy = { kind: 'USER', id: actor.userId };
      await review.save({ session });
      return { id: caseId, version: review.version };
    },
  );
}

export async function listMergeCases(actor: CommandActor, query: z.infer<typeof mergeQuery>) {
  await requirePlatformPermission(actor, PERMISSIONS.PATIENT_IDENTITY_MANAGE);
  const rows = await PatientMergeCase.find({ status: query.status, ...before(query.before) })
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean();
  return pageOf(rows, query.limit, presentRow);
}
