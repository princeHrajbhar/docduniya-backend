import { Types } from 'mongoose';
import type { z } from 'zod';
import { Organization, Facility, VerificationCase } from './organization.model.js';
import type {
  OrganizationInput,
  FacilityInput,
  submitVerificationInput,
  verificationDecisionInput,
  facilityStateInput,
  updateOrganizationInput,
  updateFacilityInput,
} from './organization.validation.js';
import type { CommandActor, Pagination } from '../../shared/domain/healthcare.js';
import { command, conflict } from '../../shared/application/command.js';
import { stamp } from '../../shared/persistence/schema.js';
import {
  bootstrapOrganizationAccess,
  authorizeOrganization,
  lockMembership,
} from '../access/access.service.js';
import { recordChange, recordRead } from '../operations/operation.service.js';
import { NumberSequence } from '../operations/operation.model.js';
import { Membership } from '../access/access.model.js';
import { requirePlatformPermission } from '../access/platform-access.js';
import { PERMISSIONS } from '../admin/auth/roles/permission.constants.js';
import { ApiError } from '../../utils/api-error.js';

export async function createOrganization(
  actor: CommandActor,
  input: OrganizationInput,
  key: string,
) {
  return command(actor, 'platform', 'organization.create', key, input, async (session) => {
    const [organization] = await Organization.create(
      [{ ...input, ...stamp(actor.userId), ownerUserId: actor.userId }],
      { session },
    );
    const id = String(organization!._id);
    await bootstrapOrganizationAccess(actor, id, session);
    await NumberSequence.create([{ organizationId: id, kind: 'MRN', nextValue: 0 }], { session });
    await recordChange(
      actor,
      {
        organizationId: id,
        action: 'OrganizationCreated',
        resourceType: 'organization',
        resourceId: id,
        version: 0,
      },
      session,
    );
    return { id, version: 0 };
  });
}
export async function getOrganization(actor: CommandActor, organizationId: string) {
  const { organization } = await authorizeOrganization(actor, organizationId, 'organization.read');
  return {
    id: String(organization._id),
    kind: organization.kind,
    legalName: organization.legalName,
    displayName: organization.displayName,
    slug: organization.slug,
    legalAddress: organization.legalAddress,
    contacts: organization.contacts,
    status: organization.status,
    version: organization.version,
  };
}
export async function updateOrganization(
  actor: CommandActor,
  organizationId: string,
  input: z.infer<typeof updateOrganizationInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'organization.manage', {
    organizationWide: true,
  });
  return command(actor, organizationId, 'organization.update', key, input, async (session) => {
    const { membership } = await authorizeOrganization(
      actor,
      organizationId,
      'organization.manage',
      { organizationWide: true, session },
    );
    await lockMembership(membership._id, session);
    const organization = await Organization.findOne({
      _id: organizationId,
      status: 'DRAFT',
      version: input.expectedVersion,
    }).session(session);
    if (!organization) conflict('Only the current draft can be edited');
    organization.set(input.profile);
    organization.updatedBy = { kind: 'USER', id: actor.userId };
    await organization.save({ session });
    await recordChange(
      actor,
      {
        organizationId,
        action: 'OrganizationDraftUpdated',
        resourceType: 'organization',
        resourceId: organizationId,
        version: organization.version,
      },
      session,
    );
    return { id: organizationId, version: organization.version };
  });
}

export async function updateFacility(
  actor: CommandActor,
  organizationId: string,
  facilityId: string,
  input: z.infer<typeof updateFacilityInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'facilities.manage', { facilityId });
  return command(
    actor,
    organizationId,
    `facility.update:${facilityId}`,
    key,
    input,
    async (session) => {
      const { membership } = await authorizeOrganization(
        actor,
        organizationId,
        'facilities.manage',
        { facilityId, session },
      );
      await lockMembership(membership._id, session);
      const facility = await Facility.findOne({
        _id: facilityId,
        organizationId,
        status: { $in: ['DRAFT', 'INACTIVE'] },
        version: input.expectedVersion,
      }).session(session);
      if (!facility) conflict('Deactivate the facility before changing its details');
      facility.set({ ...input.profile, address: input.profile.address });
      facility.updatedBy = { kind: 'USER', id: actor.userId };
      await facility.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          action: 'FacilityUpdated',
          resourceType: 'facility',
          resourceId: facilityId,
          version: facility.version,
        },
        session,
      );
      return { id: facilityId, version: facility.version };
    },
  );
}
export async function createFacility(
  actor: CommandActor,
  organizationId: string,
  input: FacilityInput,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'facilities.manage', {
    organizationWide: true,
  });
  return command(actor, organizationId, 'facility.create', key, input, async (session) => {
    const { membership } = await authorizeOrganization(actor, organizationId, 'facilities.manage', {
      session,
      organizationWide: true,
    });
    await lockMembership(membership._id, session);
    const [facility] = await Facility.create(
      [{ ...input, ...stamp(actor.userId), organizationId }],
      { session },
    );
    const id = String(facility!._id);
    await recordChange(
      actor,
      {
        organizationId,
        action: 'FacilityCreated',
        resourceType: 'facility',
        resourceId: id,
        version: 0,
      },
      session,
    );
    return { id, version: 0 };
  });
}
export async function listFacilities(
  actor: CommandActor,
  organizationId: string,
  page: Pagination,
) {
  const scope = await authorizeOrganization(actor, organizationId, 'facilities.read');
  const rows = await Facility.find({
    organizationId,
    $and: [
      scope.facilityFilter,
      page.before ? { _id: { $lt: new Types.ObjectId(page.before) } } : {},
    ],
  })
    .select('name code kind address timezone publicContacts status version')
    .sort({ _id: -1 })
    .limit(page.limit + 1)
    .lean();
  const items = rows.slice(0, page.limit).map(({ _id, ...row }) => ({ id: String(_id), ...row }));
  return { items, nextCursor: rows.length > page.limit ? items.at(-1)?.id : undefined };
}
export async function changeFacilityState(
  actor: CommandActor,
  organizationId: string,
  facilityId: string,
  input: z.infer<typeof facilityStateInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'facilities.manage', { facilityId });
  return command(
    actor,
    organizationId,
    `facility.state:${facilityId}`,
    key,
    input,
    async (session) => {
      const { organization, membership } = await authorizeOrganization(
        actor,
        organizationId,
        'facilities.manage',
        { facilityId, session },
      );
      if (input.status === 'ACTIVE' && organization.status !== 'ACTIVE')
        throw new ApiError(
          409,
          'Verify the organization before activating a facility',
          undefined,
          'PROVIDER_NOT_ACTIVE',
        );
      await lockMembership(membership._id, session);
      const updated = await Facility.findOneAndUpdate(
        { _id: facilityId, organizationId, version: input.expectedVersion },
        {
          $set: { status: input.status, updatedBy: { kind: 'USER', id: actor.userId } },
          $inc: { version: 1 },
        },
        { session, returnDocument: 'after', runValidators: true },
      );
      if (!updated) conflict();
      await recordChange(
        actor,
        {
          organizationId,
          action: 'FacilityStateChanged',
          resourceType: 'facility',
          resourceId: facilityId,
          version: updated.version,
          reason: input.reason,
        },
        session,
      );
      return { id: facilityId, version: updated.version };
    },
  );
}
export async function submitVerification(
  actor: CommandActor,
  organizationId: string,
  input: z.infer<typeof submitVerificationInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'organization.submit', {
    organizationWide: true,
  });
  return command(actor, organizationId, 'organization.submit', key, input, async (session) => {
    const { membership } = await authorizeOrganization(
      actor,
      organizationId,
      'organization.submit',
      { session, organizationWide: true },
    );
    await lockMembership(membership._id, session);
    const organization = await Organization.findOneAndUpdate(
      { _id: organizationId, status: 'DRAFT', version: input.expectedVersion },
      {
        $set: { status: 'UNDER_REVIEW', updatedBy: { kind: 'USER', id: actor.userId } },
        $inc: { version: 1 },
      },
      { session, returnDocument: 'after' },
    );
    if (!organization) conflict('Organization must be a current draft before submission');
    const [verification] = await VerificationCase.create(
      [
        {
          ...stamp(actor.userId),
          organizationId,
          submittedBy: actor.userId,
          declaration: input.declaration,
          evidenceReferences: input.evidenceReferences,
        },
      ],
      { session },
    );
    await recordChange(
      actor,
      {
        organizationId,
        action: 'ProviderVerificationSubmitted',
        resourceType: 'verificationCase',
        resourceId: String(verification!._id),
        version: 0,
      },
      session,
    );
    return { id: String(verification!._id), version: 0 };
  });
}
export async function decideVerification(
  actor: CommandActor,
  verificationId: string,
  input: z.infer<typeof verificationDecisionInput>,
  key: string,
) {
  await requirePlatformPermission(actor, PERMISSIONS.PROVIDERS_VERIFY);
  return command(
    actor,
    'platform',
    `verification.decide:${verificationId}`,
    key,
    input,
    async (session) => {
      const verification = await VerificationCase.findOne({
        _id: verificationId,
        status: 'SUBMITTED',
        version: input.expectedVersion,
      }).session(session);
      if (!verification) conflict('Verification request is no longer pending');
      const organization = await Organization.findOne({
        _id: verification.organizationId,
        status: 'UNDER_REVIEW',
      }).session(session);
      if (!organization) conflict();
      const affiliated = await Membership.exists({
        organizationId: organization._id,
        userId: actor.userId,
        status: { $ne: 'ENDED' },
      }).session(session);
      if (
        affiliated ||
        String(verification.submittedBy) === actor.userId ||
        String(organization.ownerUserId) === actor.userId
      )
        throw ApiError.forbidden('An independent reviewer must review this organization');
      verification.status = input.decision;
      verification.reason = input.reason;
      verification.decisionBy = new Types.ObjectId(actor.userId);
      verification.decisionAt = new Date();
      verification.updatedBy = { kind: 'USER', id: actor.userId };
      await verification.save({ session });
      organization.status = input.decision === 'APPROVED' ? 'ACTIVE' : 'DRAFT';
      organization.updatedBy = { kind: 'USER', id: actor.userId };
      await organization.save({ session });
      await recordChange(
        actor,
        {
          organizationId: String(organization._id),
          action: `ProviderVerification${input.decision}`,
          resourceType: 'verificationCase',
          resourceId: verificationId,
          version: verification.version,
          reason: input.reason,
        },
        session,
      );
      return { id: verificationId, version: verification.version };
    },
  );
}
export async function listVerifications(actor: CommandActor, page: Pagination) {
  await requirePlatformPermission(actor, PERMISSIONS.PROVIDERS_VERIFY);
  const rows = await VerificationCase.find({
    status: 'SUBMITTED',
    ...(page.before ? { _id: { $lt: new Types.ObjectId(page.before) } } : {}),
  })
    .sort({ _id: -1 })
    .limit(page.limit + 1)
    .lean();
  for (const row of rows.slice(0, page.limit))
    await recordRead(actor, 'verificationCase', String(row._id), String(row.organizationId));
  return {
    items: rows.slice(0, page.limit).map(({ _id, ...row }) => ({ id: String(_id), ...row })),
    nextCursor: rows.length > page.limit ? String(rows[page.limit - 1]!._id) : undefined,
  };
}
