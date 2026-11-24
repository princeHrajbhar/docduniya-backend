import { Types, type ClientSession } from 'mongoose';
import type { z } from 'zod';
import type { CommandActor, Pagination } from '../../shared/domain/healthcare.js';
import { command, conflict } from '../../shared/application/command.js';
import { stamp } from '../../shared/persistence/schema.js';
import { ApiError } from '../../utils/api-error.js';
import { recordChange } from '../operations/operation.service.js';
import { authorizeOrganization, lockMembership } from '../access/access.service.js';
import { lockActiveFacility } from '../organizations/organization.repository.js';
import { Doctor } from '../practitioners/practitioner.model.js';
import { DoctorAffiliation } from './provider.model.js';
import { ownDoctor, verifiedDoctor } from './provider.policy.js';
import type {
  affiliationInput,
  affiliationResponse,
  affiliationState,
  ownAffiliationEnd,
  publicationInput,
} from './provider.validation.js';

export async function inviteAffiliation(
  actor: CommandActor,
  organizationId: string,
  input: z.infer<typeof affiliationInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'affiliations.manage', {
    facilityId: input.facilityId,
    activeProvider: true,
  });
  return command(actor, organizationId, 'affiliation.invite', key, input, async (session) => {
    const { membership } = await authorizeOrganization(
      actor,
      organizationId,
      'affiliations.manage',
      { facilityId: input.facilityId, activeProvider: true, session },
    );
    await lockMembership(membership._id, session);
    await lockActiveFacility(organizationId, input.facilityId, session);
    await verifiedDoctor(input.doctorId, session);
    const now = new Date();
    const validFrom = input.validFrom ? new Date(input.validFrom) : now;
    const validUntil = input.validUntil ? new Date(input.validUntil) : undefined;
    if (validUntil && (validUntil <= now || validUntil <= validFrom))
      throw ApiError.badRequest(
        'Affiliation validity must end after its start and the current time',
      );
    const expired = await DoctorAffiliation.findOne({
      organizationId,
      doctorId: input.doctorId,
      facilityId: input.facilityId,
      status: 'PENDING',
      invitationExpiresAt: { $lte: now },
    }).session(session);
    if (expired) {
      expired.status = 'ENDED';
      expired.reason = 'Invitation expired';
      expired.updatedBy = { kind: 'USER', id: actor.userId };
      await expired.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          action: 'AffiliationInvitationExpired',
          resourceType: 'doctorAffiliation',
          resourceId: String(expired._id),
          version: expired.version,
        },
        session,
      );
    }
    const [affiliation] = await DoctorAffiliation.create(
      [
        {
          ...input,
          validFrom,
          validUntil,
          ...stamp(actor.userId),
          organizationId,
          invitedBy: actor.userId,
          invitationExpiresAt: new Date(now.getTime() + 7 * 86400_000),
        },
      ],
      { session },
    );
    const id = String(affiliation!._id);
    await recordChange(
      actor,
      {
        organizationId,
        action: 'DoctorAffiliationInvited',
        resourceType: 'doctorAffiliation',
        resourceId: id,
        version: 0,
      },
      session,
    );
    return { id, version: 0 };
  });
}

async function acceptScope(
  actor: CommandActor,
  organizationId: string,
  facilityId: string,
  session: ClientSession,
) {
  const scope = await authorizeOrganization(actor, organizationId, 'affiliations.accept', {
    facilityId,
    activeProvider: true,
    session,
  });
  await lockMembership(scope.membership._id, session);
  await lockActiveFacility(organizationId, facilityId, session);
  return scope;
}

export async function respondToAffiliation(
  actor: CommandActor,
  affiliationId: string,
  input: z.infer<typeof affiliationResponse>,
  key: string,
) {
  return command(
    actor,
    'self',
    `affiliation.respond:${affiliationId}`,
    key,
    input,
    async (session) => {
      const { doctor } = await ownDoctor(actor, session);
      const affiliation = await DoctorAffiliation.findOne({
        _id: affiliationId,
        doctorId: doctor._id,
        status: 'PENDING',
        version: input.expectedVersion,
        invitationExpiresAt: { $gt: new Date() },
      }).session(session);
      if (!affiliation) throw ApiError.notFound('Affiliation invitation is unavailable or expired');
      if (input.decision === 'ACCEPT') {
        await verifiedDoctor(String(doctor._id), session);
        if (affiliation.validUntil && affiliation.validUntil <= new Date())
          conflict('The affiliation has expired');
        const { membership } = await acceptScope(
          actor,
          String(affiliation.organizationId),
          String(affiliation.facilityId),
          session,
        );
        affiliation.membershipId = membership._id;
        affiliation.membershipValidFrom = membership.validFrom;
        affiliation.status = 'ACTIVE';
        affiliation.acceptedBy = new Types.ObjectId(actor.userId);
        affiliation.acceptedAt = new Date();
        await Doctor.updateOne(
          { _id: doctor._id },
          { $inc: { authorizationFence: 1 } },
          { session },
        );
      } else affiliation.status = 'REJECTED';
      affiliation.updatedBy = { kind: 'USER', id: actor.userId };
      await affiliation.save({ session });
      await recordChange(
        actor,
        {
          organizationId: String(affiliation.organizationId),
          action: `DoctorAffiliation${input.decision}`,
          resourceType: 'doctorAffiliation',
          resourceId: affiliationId,
          version: affiliation.version,
        },
        session,
      );
      return { id: affiliationId, version: affiliation.version };
    },
  );
}

export async function changeAffiliation(
  actor: CommandActor,
  organizationId: string,
  affiliationId: string,
  input: z.infer<typeof affiliationState>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'affiliations.manage', {
    activeProvider: true,
  });
  return command(
    actor,
    organizationId,
    `affiliation.state:${affiliationId}`,
    key,
    input,
    async (session) => {
      const affiliation = await DoctorAffiliation.findOne({
        _id: affiliationId,
        organizationId,
        version: input.expectedVersion,
      }).session(session);
      if (!affiliation) conflict();
      const { membership } = await authorizeOrganization(
        actor,
        organizationId,
        'affiliations.manage',
        { facilityId: String(affiliation.facilityId), activeProvider: true, session },
      );
      await lockMembership(membership._id, session);
      if (
        ['ENDED', 'REJECTED'].includes(affiliation.status) ||
        (affiliation.status === 'PENDING' && input.status !== 'ENDED')
      )
        conflict(
          'Only the invited doctor may accept; terminal affiliations require a new invitation',
        );
      if (input.status === 'ACTIVE') {
        if (affiliation.status !== 'SUSPENDED')
          conflict('Only suspended affiliations may be resumed');
        await verifiedDoctor(String(affiliation.doctorId), session);
        await lockActiveFacility(organizationId, String(affiliation.facilityId), session);
        if (affiliation.validUntil && affiliation.validUntil <= new Date())
          conflict('Expired affiliations require a new invitation');
      }
      affiliation.status = input.status;
      affiliation.reason = input.reason;
      affiliation.updatedBy = { kind: 'USER', id: actor.userId };
      await affiliation.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          action: 'DoctorAffiliationStateChanged',
          resourceType: 'doctorAffiliation',
          resourceId: affiliationId,
          version: affiliation.version,
          reason: input.reason,
        },
        session,
      );
      return { id: affiliationId, version: affiliation.version };
    },
  );
}

export async function endOwnAffiliation(
  actor: CommandActor,
  affiliationId: string,
  input: z.infer<typeof ownAffiliationEnd>,
  key: string,
) {
  return command(actor, 'self', `affiliation.end:${affiliationId}`, key, input, async (session) => {
    const { doctor } = await ownDoctor(actor, session);
    const affiliation = await DoctorAffiliation.findOne({
      _id: affiliationId,
      doctorId: doctor._id,
      version: input.expectedVersion,
      status: { $in: ['PENDING', 'ACTIVE', 'SUSPENDED'] },
    }).session(session);
    if (!affiliation) conflict();
    affiliation.status = 'ENDED';
    affiliation.reason = input.reason;
    affiliation.updatedBy = { kind: 'USER', id: actor.userId };
    await affiliation.save({ session });
    await recordChange(
      actor,
      {
        organizationId: String(affiliation.organizationId),
        action: 'DoctorAffiliationEndedByDoctor',
        resourceType: 'doctorAffiliation',
        resourceId: affiliationId,
        version: affiliation.version,
        reason: input.reason,
      },
      session,
    );
    return { id: affiliationId, version: affiliation.version };
  });
}

export async function listAffiliations(
  actor: CommandActor,
  page: Pagination,
  organizationId?: string,
) {
  let filter;
  if (organizationId) {
    const { membership } = await authorizeOrganization(
      actor,
      organizationId,
      'affiliations.manage',
    );
    filter = {
      organizationId,
      ...(membership.facilityScope === 'SELECTED'
        ? { facilityId: { $in: membership.facilityIds } }
        : {}),
    };
  } else filter = { doctorId: (await ownDoctor(actor)).doctor._id };
  const rows = await DoctorAffiliation.find({
    ...filter,
    ...(page.before ? { _id: { $lt: new Types.ObjectId(page.before) } } : {}),
  })
    .select(
      'organizationId facilityId doctorId title department status validFrom validUntil invitationExpiresAt acceptedAt version',
    )
    .sort({ _id: -1 })
    .limit(page.limit + 1)
    .lean();
  return {
    items: rows.slice(0, page.limit).map(({ _id, ...row }) => ({ id: String(_id), ...row })),
    nextCursor: rows.length > page.limit ? String(rows[page.limit - 1]!._id) : undefined,
  };
}

export async function publishDoctor(
  actor: CommandActor,
  input: z.infer<typeof publicationInput>,
  key: string,
) {
  return command(actor, 'self', 'doctor.publication', key, input, async (session) => {
    const { doctor } = await ownDoctor(actor, session);
    if (doctor.version !== input.expectedVersion) conflict();
    if (input.published) {
      await verifiedDoctor(String(doctor._id), session);
      const now = new Date();
      const candidates = DoctorAffiliation.find({
        doctorId: doctor._id,
        status: 'ACTIVE',
        validFrom: { $lte: now },
        $or: [{ validUntil: { $exists: false } }, { validUntil: { $gt: now } }],
      })
        .session(session)
        .cursor();
      let eligible = false;
      for await (const affiliation of candidates) {
        try {
          const { membership } = await authorizeOrganization(
            actor,
            String(affiliation.organizationId),
            'affiliations.accept',
            { facilityId: String(affiliation.facilityId), activeProvider: true, session },
          );
          if (
            String(membership._id) !== String(affiliation.membershipId) ||
            membership.validFrom.getTime() !== affiliation.membershipValidFrom?.getTime()
          )
            continue;
          await lockMembership(membership._id, session);
          await lockActiveFacility(
            String(affiliation.organizationId),
            String(affiliation.facilityId),
            session,
          );
          await DoctorAffiliation.updateOne(
            { _id: affiliation._id },
            { $inc: { authorizationFence: 1 } },
            { session },
          );
          eligible = true;
          break;
        } catch (error) {
          if (!(error instanceof ApiError) || ![403, 404, 409].includes(error.statusCode))
            throw error;
        }
      }
      await candidates.close();
      if (!eligible)
        throw ApiError.badRequest(
          'An active accepted provider affiliation is required before publication',
        );
    }
    doctor.profilePublished = input.published;
    doctor.updatedBy = { kind: 'USER', id: actor.userId };
    await doctor.save({ session });
    await recordChange(
      actor,
      {
        action: input.published ? 'DoctorProfilePublished' : 'DoctorProfileUnpublished',
        resourceType: 'doctor',
        resourceId: String(doctor._id),
        version: doctor.version,
      },
      session,
    );
    return { id: String(doctor._id), version: doctor.version };
  });
}
