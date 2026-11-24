import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import mongoose from 'mongoose';
import type { CommandActor } from '../../shared/domain/healthcare.js';
import { command, conflict } from '../../shared/application/command.js';
import { scoped } from '../../shared/application/scope.js';
import { stamp } from '../../shared/persistence/schema.js';
import { ApiError } from '../../utils/api-error.js';
import { isDuplicateKeyError } from '../../utils/mongo.js';
import { recordChange } from '../operations/operation.service.js';
import { AuditEvent, OutboxEvent } from '../operations/operation.model.js';
import { Organization } from '../organizations/organization.model.js';
import { authorizeOrganization } from './access.service.js';
import { Membership, RoleAssignment, ScopedRole } from './access.model.js';
import { ROLE_TEMPLATES } from './access.constants.js';
import type { roleAssignmentInput, roleRevocationInput } from './membership.validation.js';

/**
 * Grants an additional built-in role to an existing active member. Self-assignment is allowed
 * only for the owner of a solo practice (who is also its clinician). Clinical actions still
 * require the professional's own verified credentials.
 */
export async function assignRole(
  actor: CommandActor,
  organizationId: string,
  membershipId: string,
  input: z.infer<typeof roleAssignmentInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'roles.assign', { organizationWide: true });
  try {
    return await command(
      actor,
      organizationId,
      `role.assign:${membershipId}`,
      key,
      input,
      async (session) => {
        const scope = await scoped(actor, organizationId, 'roles.assign', session, {
          organizationWide: true,
        });
        const membership = await Membership.findOne({
          _id: membershipId,
          organizationId,
          status: 'ACTIVE',
        }).session(session);
        if (!membership) throw ApiError.notFound('Active membership is unavailable');
        if (
          String(membership.userId) === actor.userId &&
          scope.organization.kind !== 'SOLO_PRACTICE'
        )
          throw ApiError.forbidden('Another administrator must grant your roles');
        const role = await ScopedRole.findOne({
          organizationId,
          slug: input.role,
          status: 'ACTIVE',
        }).session(session);
        if (!role) throw ApiError.notFound('Role is unavailable');
        const [assignment] = await RoleAssignment.create(
          [
            {
              ...stamp(actor.userId),
              organizationId,
              userId: membership.userId,
              membershipId: membership._id,
              roleId: role._id,
              scopeKey: `org:${organizationId}`,
              validFrom: new Date(),
              validUntil: input.validUntil ? new Date(input.validUntil) : undefined,
            },
          ],
          { session },
        );
        // Serializes with concurrent authorization decisions relying on this membership.
        await Membership.updateOne(
          { _id: membership._id },
          { $inc: { authorizationFence: 1 } },
          { session },
        );
        await recordChange(
          actor,
          {
            organizationId,
            action: 'RoleAssigned',
            resourceType: 'roleAssignment',
            resourceId: String(assignment!._id),
            version: 0,
            reason: input.role,
          },
          session,
        );
        return { id: String(assignment!._id), version: 0 };
      },
    );
  } catch (error) {
    if (isDuplicateKeyError(error)) conflict('The member already holds this role');
    throw error;
  }
}

export async function revokeRole(
  actor: CommandActor,
  organizationId: string,
  assignmentId: string,
  input: z.infer<typeof roleRevocationInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'roles.assign', { organizationWide: true });
  return command(
    actor,
    organizationId,
    `role.revoke:${assignmentId}`,
    key,
    input,
    async (session) => {
      await scoped(actor, organizationId, 'roles.assign', session, { organizationWide: true });
      const assignment = await RoleAssignment.findOne({
        _id: assignmentId,
        organizationId,
        version: input.expectedVersion,
        revokedAt: { $exists: false },
      }).session(session);
      if (!assignment) conflict();
      const role = await ScopedRole.findById(assignment.roleId).session(session);
      if (role?.slug === 'owner')
        throw ApiError.forbidden('Ownership changes need a reviewed transfer');
      assignment.revokedAt = new Date();
      assignment.updatedBy = { kind: 'USER', id: actor.userId };
      await assignment.save({ session });
      await Membership.updateOne(
        { _id: assignment.membershipId },
        { $inc: { authorizationFence: 1 } },
        { session },
      );
      await recordChange(
        actor,
        {
          organizationId,
          action: 'RoleRevoked',
          resourceType: 'roleAssignment',
          resourceId: assignmentId,
          version: assignment.version,
          reason: input.reason,
        },
        session,
      );
      return { id: assignmentId, version: assignment.version };
    },
  );
}

export async function listRoleAssignments(
  actor: CommandActor,
  organizationId: string,
  membershipId: string,
) {
  await authorizeOrganization(actor, organizationId, 'memberships.read');
  const rows = await RoleAssignment.find({ organizationId, membershipId })
    .sort({ _id: -1 })
    .limit(100)
    .lean();
  const roles = await ScopedRole.find({ _id: { $in: rows.map((row) => row.roleId) } })
    .select({ slug: 1, name: 1 })
    .lean();
  const byId = new Map(roles.map((role) => [String(role._id), role]));
  return rows.map((row) => ({
    id: String(row._id),
    role: byId.get(String(row.roleId))?.slug,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    revokedAt: row.revokedAt,
    version: row.version,
  }));
}

/**
 * Explicit additive upgrade for organizations created before a role template changed: creates
 * missing built-in roles and adds missing template permissions to built-in roles. Never removes
 * a permission or touches custom roles. Idempotent.
 */
export async function upgradeBuiltInRoles(): Promise<number> {
  const actor = { kind: 'SERVICE' as const, id: 'role-templates-v2' };
  let changes = 0;
  for await (const organization of Organization.find().select({ _id: 1 }).cursor()) {
    const organizationId = String(organization._id);
    for (const template of ROLE_TEMPLATES) {
      const changed = await mongoose.connection.transaction(async (session) => {
        const role = await ScopedRole.findOne({
          organizationId,
          scopeKey: `org:${organizationId}`,
          slug: template.slug,
        }).session(session);
        if (role && !role.system) return false;
        const missing = template.permissions.filter(
          (code) => !role?.permissionCodes.includes(code),
        );
        if (role && !missing.length) return false;
        let id: string;
        let version: number;
        if (role) {
          role.permissionCodes.push(...missing);
          role.updatedBy = actor;
          await role.save({ session });
          id = String(role._id);
          version = role.version;
        } else {
          const [created] = await ScopedRole.create(
            [
              {
                organizationId,
                scopeKey: `org:${organizationId}`,
                slug: template.slug,
                name: template.name,
                permissionCodes: template.permissions,
                createdBy: actor,
                updatedBy: actor,
              },
            ],
            { session },
          );
          id = String(created!._id);
          version = 0;
        }
        const requestId = randomUUID();
        await AuditEvent.create(
          [
            {
              actor,
              action: 'BuiltInRoleUpgraded',
              resourceType: 'scopedRole',
              resourceId: id,
              organizationId,
              outcome: 'SUCCESS',
              requestId,
              reason: template.slug,
            },
          ],
          { session },
        );
        await OutboxEvent.create(
          [
            {
              eventId: randomUUID(),
              actor,
              type: 'BuiltInRoleUpgraded',
              aggregateType: 'scopedRole',
              aggregateId: id,
              aggregateVersion: version,
              organizationId,
              correlationId: requestId,
            },
          ],
          { session },
        );
        return true;
      });
      if (changed) changes += 1;
    }
  }
  return changes;
}
