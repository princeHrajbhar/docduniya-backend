import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { ScopedRole } from '../modules/access/access.model.js';
import { AuditEvent, OutboxEvent } from '../modules/operations/operation.model.js';
import type { OrgPermission } from '../modules/access/access.constants.js';

/** Explicit additive upgrade for built-in roles created by the previous foundation. */
export async function upgradeProviderPermissions(): Promise<void> {
  const actor = { kind: 'SERVICE' as const, id: 'provider-permissions-v1' };
  for (const slug of ['owner', 'administrator', 'clinician']) {
    const additions: OrgPermission[] =
      slug === 'clinician'
        ? ['affiliations.accept']
        : ['affiliations.accept', 'affiliations.manage'];
    const cursor = ScopedRole.find({
      system: true,
      slug,
      permissionCodes: { $not: { $all: additions } },
    })
      .select('_id')
      .cursor();
    for await (const candidate of cursor) {
      await mongoose.connection.transaction(async (session) => {
        const role = await ScopedRole.findById(candidate._id).session(session);
        if (!role || additions.every((code) => role.permissionCodes.includes(code))) return;
        role.permissionCodes.push(
          ...additions.filter((code) => !role.permissionCodes.includes(code)),
        );
        role.updatedBy = actor;
        await role.save({ session });
        const requestId = randomUUID();
        await AuditEvent.create(
          [
            {
              actor,
              action: 'ProviderPermissionsAdded',
              resourceType: 'scopedRole',
              resourceId: role._id,
              organizationId: role.organizationId,
              outcome: 'SUCCESS',
              requestId,
            },
          ],
          { session },
        );
        await OutboxEvent.create(
          [
            {
              eventId: randomUUID(),
              actor,
              type: 'ProviderPermissionsAdded',
              aggregateType: 'scopedRole',
              aggregateId: role._id,
              aggregateVersion: role.version,
              organizationId: role.organizationId,
              correlationId: requestId,
            },
          ],
          { session },
        );
      });
    }
  }
}
