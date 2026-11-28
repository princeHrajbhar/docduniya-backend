import type { CommandActor } from '../../shared/domain/healthcare.js';
import { Organization } from '../organizations/organization.model.js';
import { Membership, RoleAssignment, ScopedRole } from './access.model.js';

/**
 * The signed-in account's provider workspaces, for navigation: each current membership with its
 * organization, facility scope, roles and the union of their permission codes, plus pending
 * invitations. It uses the same validity rules as `authorizeOrganization`, so a permission listed
 * here is one the server currently grants; every command still re-checks it.
 */
export async function myWorkspaces(actor: CommandActor) {
  const now = new Date();
  const current = {
    validFrom: { $lte: now },
    $or: [{ validUntil: { $exists: false } }, { validUntil: { $gt: now } }],
  };
  const memberships = await Membership.find({
    userId: actor.userId,
    $or: [
      { status: 'ACTIVE', ...current },
      { status: 'INVITED', invitationExpiresAt: { $gt: now } },
    ],
  })
    .select(
      'organizationId status facilityScope facilityIds validFrom validUntil invitationExpiresAt version',
    )
    .sort({ _id: -1 })
    .limit(200)
    .lean();
  const active = memberships.filter((membership) => membership.status === 'ACTIVE');
  const [organizations, assignments] = await Promise.all([
    Organization.find({ _id: { $in: memberships.map((membership) => membership.organizationId) } })
      .select('kind displayName slug status')
      .lean(),
    RoleAssignment.find({
      userId: actor.userId,
      membershipId: { $in: active.map((membership) => membership._id) },
      revokedAt: { $exists: false },
      ...current,
    })
      .select('organizationId membershipId roleId')
      .lean(),
  ]);
  const roles = await ScopedRole.find({
    _id: { $in: assignments.map((assignment) => assignment.roleId) },
    status: 'ACTIVE',
  })
    .select('organizationId scopeKey slug name permissionCodes')
    .lean();
  const organizationById = new Map(organizations.map((org) => [String(org._id), org]));
  const roleById = new Map(roles.map((role) => [String(role._id), role]));

  const describe = (membership: (typeof memberships)[number]) => {
    const organizationId = String(membership.organizationId);
    const organization = organizationById.get(organizationId);
    return {
      membershipId: String(membership._id),
      membershipVersion: membership.version,
      organization: organization
        ? {
            id: organizationId,
            kind: organization.kind,
            displayName: organization.displayName,
            slug: organization.slug,
            status: organization.status,
          }
        : { id: organizationId },
      facilityScope: membership.facilityScope,
      facilityIds: membership.facilityIds.map(String),
    };
  };

  return {
    workspaces: active.map((membership) => {
      const organizationId = String(membership.organizationId);
      const held = assignments
        .filter((assignment) => String(assignment.membershipId) === String(membership._id))
        .map((assignment) => roleById.get(String(assignment.roleId)))
        .filter(
          (role): role is NonNullable<typeof role> =>
            Boolean(role) &&
            String(role!.organizationId) === organizationId &&
            role!.scopeKey === `org:${organizationId}`,
        );
      return {
        ...describe(membership),
        roles: held.map((role) => ({ slug: role.slug, name: role.name })),
        permissions: [...new Set(held.flatMap((role) => role.permissionCodes))].sort(),
      };
    }),
    invitations: memberships
      .filter((membership) => membership.status === 'INVITED')
      .map((membership) => ({
        ...describe(membership),
        invitationExpiresAt: membership.invitationExpiresAt,
      })),
  };
}
