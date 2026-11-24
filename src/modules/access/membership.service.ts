import { Types } from 'mongoose';
import type { z } from 'zod';
import type { CommandActor, Pagination } from '../../shared/domain/healthcare.js';
import { command, conflict } from '../../shared/application/command.js';
import { stamp } from '../../shared/persistence/schema.js';
import { ApiError } from '../../utils/api-error.js';
import { User } from '../admin/auth/models/user.model.js';
import { authorizeOrganization, lockMembership } from './access.service.js';
import { Membership, RoleAssignment, ScopedRole } from './access.model.js';
import {
  assertFacilities,
  organizationForScope,
} from '../organizations/organization.repository.js';
import { recordChange } from '../operations/operation.service.js';
import type { inviteInput, membershipStateInput, acceptInput } from './membership.validation.js';

export async function inviteMember(
  actor: CommandActor,
  organizationId: string,
  input: z.infer<typeof inviteInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'memberships.manage', {
    organizationWide: true,
  });
  return command(actor, organizationId, 'membership.invite', key, input, async (session) => {
    const scope = await authorizeOrganization(actor, organizationId, 'memberships.manage', {
      session,
      organizationWide: true,
    });
    await lockMembership(scope.membership._id, session);
    if (
      !(await User.exists({ _id: input.userId, isActive: true, isVerified: true }).session(session))
    )
      throw ApiError.notFound('Verified account is unavailable');
    await assertFacilities(organizationId, input.facilityIds, session);
    const now = new Date();
    let membership = await Membership.findOne({ organizationId, userId: input.userId }).session(
      session,
    );
    if (
      membership &&
      (['ACTIVE', 'SUSPENDED'].includes(membership.status) ||
        (membership.status === 'INVITED' &&
          membership.invitationExpiresAt &&
          membership.invitationExpiresAt > now))
    ) {
      throw new ApiError(
        409,
        'An active membership or invitation already exists',
        undefined,
        'MEMBERSHIP_EXISTS',
      );
    }
    const fields = {
      organizationId,
      userId: input.userId,
      invitedBy: actor.userId,
      status: 'INVITED' as const,
      facilityScope: input.facilityScope,
      facilityIds: input.facilityIds,
      validFrom: now,
      invitationExpiresAt: new Date(now.getTime() + 7 * 86400_000),
      updatedBy: { kind: 'USER', id: actor.userId },
    };
    if (membership) {
      membership.set(fields);
      membership.validUntil = undefined;
      await membership.save({ session });
      await RoleAssignment.updateMany(
        { membershipId: membership._id, organizationId, revokedAt: { $exists: false } },
        { $set: { revokedAt: now }, $inc: { version: 1 } },
        { session },
      );
    } else {
      const [created] = await Membership.create([{ ...fields, ...stamp(actor.userId) }], {
        session,
      });
      membership = created!;
    }
    const role = await ScopedRole.findOne({
      organizationId,
      slug: input.role,
      status: 'ACTIVE',
    }).session(session);
    if (!role) throw ApiError.notFound('Role is unavailable');
    await RoleAssignment.create(
      [
        {
          ...stamp(actor.userId),
          organizationId,
          userId: input.userId,
          membershipId: membership!._id,
          roleId: role._id,
          scopeKey: `org:${organizationId}`,
          validFrom: now,
        },
      ],
      { session },
    );
    const id = String(membership!._id);
    await recordChange(
      actor,
      {
        organizationId,
        action: 'MembershipInvited',
        resourceType: 'membership',
        resourceId: id,
        version: membership!.version,
      },
      session,
    );
    return { id, version: membership!.version };
  });
}
export async function acceptInvitation(
  actor: CommandActor,
  membershipId: string,
  input: z.infer<typeof acceptInput>,
  key: string,
) {
  return command(
    actor,
    'self',
    `membership.accept:${membershipId}`,
    key,
    input,
    async (session) => {
      const membership = await Membership.findOne({
        _id: membershipId,
        userId: actor.userId,
        status: 'INVITED',
        version: input.expectedVersion,
        invitationExpiresAt: { $gt: new Date() },
      }).session(session);
      if (!membership) throw ApiError.notFound('Invitation is unavailable or expired');
      await organizationForScope(String(membership.organizationId), session);
      membership.status = 'ACTIVE';
      membership.updatedBy = { kind: 'USER', id: actor.userId };
      await membership.save({ session });
      await recordChange(
        actor,
        {
          organizationId: String(membership.organizationId),
          action: 'MembershipAccepted',
          resourceType: 'membership',
          resourceId: membershipId,
          version: membership.version,
        },
        session,
      );
      return { id: membershipId, version: membership.version };
    },
  );
}
export async function changeMembership(
  actor: CommandActor,
  organizationId: string,
  membershipId: string,
  input: z.infer<typeof membershipStateInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'memberships.manage', {
    organizationWide: true,
  });
  return command(
    actor,
    organizationId,
    `membership.state:${membershipId}`,
    key,
    input,
    async (session) => {
      const scope = await authorizeOrganization(actor, organizationId, 'memberships.manage', {
        session,
        organizationWide: true,
      });
      const membership = await Membership.findOne({
        _id: membershipId,
        organizationId,
        version: input.expectedVersion,
      }).session(session);
      if (!membership) conflict();
      if (
        String(membership.userId) === String(scope.organization.ownerUserId) ||
        String(membership.userId) === actor.userId
      )
        throw ApiError.forbidden(
          'Owner and self membership changes require a separate ownership workflow',
        );
      if (
        membership.status === 'ENDED' ||
        (membership.status === 'INVITED' && input.status !== 'ENDED')
      )
        conflict('Only the invited account may accept an invitation');
      await lockMembership(scope.membership._id, session);
      membership.status = input.status;
      membership.updatedBy = { kind: 'USER', id: actor.userId };
      await membership.save({ session });
      if (input.status === 'ENDED')
        await RoleAssignment.updateMany(
          { organizationId, membershipId, revokedAt: { $exists: false } },
          { $set: { revokedAt: new Date() }, $inc: { version: 1 } },
          { session },
        );
      await recordChange(
        actor,
        {
          organizationId,
          action: 'MembershipStateChanged',
          resourceType: 'membership',
          resourceId: membershipId,
          version: membership.version,
          reason: input.reason,
        },
        session,
      );
      return { id: membershipId, version: membership.version };
    },
  );
}
export async function listMemberships(
  actor: CommandActor,
  page: Pagination,
  organizationId?: string,
) {
  if (organizationId)
    await authorizeOrganization(actor, organizationId, 'memberships.read', {
      organizationWide: true,
    });
  const rows = await Membership.find({
    ...(organizationId ? { organizationId } : { userId: actor.userId }),
    ...(page.before ? { _id: { $lt: new Types.ObjectId(page.before) } } : {}),
  })
    .select(
      'organizationId userId status facilityScope facilityIds validFrom validUntil invitationExpiresAt version',
    )
    .sort({ _id: -1 })
    .limit(page.limit + 1)
    .lean();
  const items = rows.slice(0, page.limit).map(({ _id, ...row }) => ({ id: String(_id), ...row }));
  return { items, nextCursor: rows.length > page.limit ? items.at(-1)?.id : undefined };
}
