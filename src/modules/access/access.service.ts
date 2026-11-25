import { Types, type ClientSession } from 'mongoose';
import { ApiError } from '../../utils/api-error.js';
import type { CommandActor } from '../../shared/domain/healthcare.js';
import { stamp } from '../../shared/persistence/schema.js';
import { Membership, ScopedRole, RoleAssignment } from './access.model.js';
import { ROLE_TEMPLATES, type OrgPermission } from './access.constants.js';
import { organizationForScope } from '../organizations/organization.repository.js';
import { requireMfaForPrivilege } from '../admin/auth/mfa/mfa.service.js';

/** Administration that can change who has access or move money needs a second factor. */
const PRIVILEGED_PERMISSIONS = new Set<OrgPermission>([
  'organization.manage',
  'memberships.manage',
  'roles.assign',
  'merchant.manage',
  'payments.refund',
  'ledger.read',
  'audit.read',
]);

export async function bootstrapOrganizationAccess(
  actor: CommandActor,
  organizationId: string,
  session: ClientSession,
): Promise<void> {
  const now = new Date();
  const [membership] = await Membership.create(
    [
      {
        ...stamp(actor.userId),
        organizationId,
        userId: actor.userId,
        invitedBy: actor.userId,
        status: 'ACTIVE',
        facilityScope: 'ALL',
        facilityIds: [],
        validFrom: now,
      },
    ],
    { session },
  );
  for (const definition of ROLE_TEMPLATES) {
    const [role] = await ScopedRole.create(
      [
        {
          ...stamp(actor.userId),
          organizationId,
          scopeKey: `org:${organizationId}`,
          slug: definition.slug,
          name: definition.name,
          permissionCodes: definition.permissions,
        },
      ],
      { session },
    );
    if (definition.slug === 'owner') {
      await RoleAssignment.create(
        [
          {
            ...stamp(actor.userId),
            userId: actor.userId,
            organizationId,
            membershipId: membership!._id,
            roleId: role!._id,
            scopeKey: `org:${organizationId}`,
            validFrom: now,
          },
        ],
        { session },
      );
    }
  }
}

export async function authorizeOrganization(
  actor: CommandActor,
  organizationId: string,
  permission: OrgPermission,
  options: {
    session?: ClientSession;
    facilityId?: string;
    organizationWide?: boolean;
    activeProvider?: boolean;
  } = {},
) {
  const { session } = options;
  const now = new Date();
  const membership = await Membership.findOne({
    organizationId,
    userId: actor.userId,
    status: 'ACTIVE',
    validFrom: { $lte: now },
    $or: [{ validUntil: { $exists: false } }, { validUntil: { $gt: now } }],
  })
    .session(session ?? null)
    .lean();
  if (!membership) throw ApiError.notFound('Organization is unavailable');
  const organization = await organizationForScope(organizationId, session);
  if (options.activeProvider && organization.status !== 'ACTIVE')
    throw new ApiError(
      409,
      'Provider verification is required before this operation',
      undefined,
      'PROVIDER_NOT_ACTIVE',
    );
  const facilityIds = membership.facilityIds.map(String);
  if (options.organizationWide && membership.facilityScope !== 'ALL')
    throw ApiError.forbidden('Organization-wide access is required');
  if (
    options.facilityId &&
    membership.facilityScope === 'SELECTED' &&
    !facilityIds.includes(options.facilityId)
  )
    throw ApiError.notFound('Facility is unavailable');
  const assignments = await RoleAssignment.find({
    organizationId,
    membershipId: membership._id,
    userId: actor.userId,
    revokedAt: { $exists: false },
    validFrom: { $lte: now },
    $or: [{ validUntil: { $exists: false } }, { validUntil: { $gt: now } }],
  })
    .session(session ?? null)
    .lean();
  const roles = await ScopedRole.find({
    _id: { $in: assignments.map((v) => v.roleId) },
    organizationId,
    scopeKey: `org:${organizationId}`,
    status: 'ACTIVE',
  })
    .session(session ?? null)
    .lean();
  if (!roles.some((v) => v.permissionCodes.includes(permission)))
    throw ApiError.forbidden('Insufficient organization permissions');
  if (PRIVILEGED_PERMISSIONS.has(permission)) await requireMfaForPrivilege(actor.userId);
  return {
    organization,
    membership,
    facilityFilter:
      membership.facilityScope === 'ALL'
        ? {}
        : { _id: { $in: facilityIds.map((id) => new Types.ObjectId(id)) } },
  };
}

export async function lockMembership(id: Types.ObjectId, session: ClientSession): Promise<void> {
  // Serialize a mutation with suspension/revocation of the authority it relies on.
  const result = await Membership.updateOne(
    { _id: id, status: 'ACTIVE' },
    { $inc: { authorizationFence: 1 } },
    { session },
  );
  if (!result.matchedCount) throw ApiError.forbidden('Membership is no longer active');
}
