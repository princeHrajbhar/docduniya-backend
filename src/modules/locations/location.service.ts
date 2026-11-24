import { z } from 'zod';
import type { CommandActor } from '../../shared/domain/healthcare.js';
import { label, objectId, paginationInput, version } from '../../shared/domain/healthcare.js';
import { command, conflict } from '../../shared/application/command.js';
import { before, pageOf, scoped } from '../../shared/application/scope.js';
import { stamp } from '../../shared/persistence/schema.js';
import { ApiError } from '../../utils/api-error.js';
import { isDuplicateKeyError } from '../../utils/mongo.js';
import { authorizeOrganization } from '../access/access.service.js';
import { Facility } from '../organizations/organization.model.js';
import { recordChange } from '../operations/operation.service.js';
import { FacilityLocation } from './location.model.js';

const CHILD_KINDS: Record<string, string[]> = {
  BUILDING: ['FLOOR', 'WARD', 'ROOM', 'THEATRE', 'STORE'],
  FLOOR: ['WARD', 'ROOM', 'THEATRE', 'STORE'],
  WARD: ['ROOM', 'BED'],
  ROOM: ['BED'],
  BED: [],
  THEATRE: [],
  STORE: [],
};

export const locationInput = z.strictObject({
  facilityId: objectId,
  parentId: objectId.optional(),
  code: z.string().regex(/^[A-Z0-9][A-Z0-9-]{0,39}$/, 'Use uppercase letters, digits and hyphens'),
  name: label,
  kind: z.enum(['BUILDING', 'FLOOR', 'WARD', 'ROOM', 'BED', 'THEATRE', 'STORE']),
  capabilities: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
  genderRestriction: z.enum(['FEMALE', 'MALE']).optional(),
  isolationCapable: z.boolean().default(false),
});
export const locationStateInput = z.strictObject({
  expectedVersion: version,
  status: z.enum(['AVAILABLE', 'CLEANING', 'MAINTENANCE', 'CLOSED']),
  reason: z.string().trim().min(5).max(1000),
});
export const locationQuery = paginationInput.extend({
  facilityId: objectId,
  kind: z.enum(['BUILDING', 'FLOOR', 'WARD', 'ROOM', 'BED', 'THEATRE', 'STORE']).optional(),
  status: z.enum(['AVAILABLE', 'OCCUPIED', 'CLEANING', 'MAINTENANCE', 'CLOSED']).optional(),
});

export async function createLocation(
  actor: CommandActor,
  organizationId: string,
  input: z.infer<typeof locationInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'facilities.manage', {
    facilityId: input.facilityId,
  });
  try {
    return await command(actor, organizationId, 'location.create', key, input, async (session) => {
      await scoped(actor, organizationId, 'facilities.manage', session, {
        facilityId: input.facilityId,
      });
      if (
        !(await Facility.exists({
          _id: input.facilityId,
          organizationId,
          status: { $ne: 'INACTIVE' },
        }).session(session))
      )
        throw ApiError.notFound('Facility is unavailable');
      if (input.parentId) {
        // Children are always created under an existing parent, so the hierarchy stays acyclic.
        const parent = await FacilityLocation.findOne({
          _id: input.parentId,
          organizationId,
          facilityId: input.facilityId,
        }).session(session);
        if (!parent) throw ApiError.notFound('Parent location is unavailable');
        if (!CHILD_KINDS[parent.kind]!.includes(input.kind))
          throw ApiError.badRequest(
            `A ${parent.kind.toLowerCase()} cannot contain a ${input.kind.toLowerCase()}`,
          );
      } else if (input.kind === 'BED') throw ApiError.badRequest('Beds belong to a ward or room');
      const [location] = await FacilityLocation.create(
        [{ ...stamp(actor.userId), organizationId, ...input }],
        { session },
      );
      await recordChange(
        actor,
        {
          organizationId,
          action: 'LocationCreated',
          resourceType: 'facilityLocation',
          resourceId: String(location!._id),
          version: 0,
        },
        session,
      );
      return { id: String(location!._id), version: 0 };
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) conflict('This location code already exists at the facility');
    throw error;
  }
}

/** Operational changes; occupancy is set only by bed-assignment commands. */
export async function changeLocationState(
  actor: CommandActor,
  organizationId: string,
  locationId: string,
  input: z.infer<typeof locationStateInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'inpatient.manage');
  return command(
    actor,
    organizationId,
    `location.state:${locationId}`,
    key,
    input,
    async (session) => {
      const location = await FacilityLocation.findOne({
        _id: locationId,
        organizationId,
        version: input.expectedVersion,
      }).session(session);
      if (!location) conflict();
      await scoped(actor, organizationId, 'inpatient.manage', session, {
        facilityId: String(location.facilityId),
      });
      if (location.operationalStatus === 'OCCUPIED')
        conflict('Occupied beds change through transfer or discharge');
      location.operationalStatus = input.status;
      location.updatedBy = { kind: 'USER', id: actor.userId };
      await location.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          action: `Location.${input.status}`,
          resourceType: 'facilityLocation',
          resourceId: locationId,
          version: location.version,
          reason: input.reason,
        },
        session,
      );
      return { id: locationId, version: location.version };
    },
  );
}

export async function listLocations(
  actor: CommandActor,
  organizationId: string,
  query: z.infer<typeof locationQuery>,
) {
  await authorizeOrganization(actor, organizationId, 'facilities.read', {
    facilityId: query.facilityId,
  });
  const rows = await FacilityLocation.find({
    organizationId,
    facilityId: query.facilityId,
    ...(query.kind ? { kind: query.kind } : {}),
    ...(query.status ? { operationalStatus: query.status } : {}),
    ...before(query.before),
  })
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean();
  return pageOf(rows, query.limit, (row) => ({
    id: String(row._id),
    parentId: row.parentId ? String(row.parentId) : undefined,
    code: row.code,
    name: row.name,
    kind: row.kind,
    operationalStatus: row.operationalStatus,
    capabilities: row.capabilities,
    genderRestriction: row.genderRestriction,
    isolationCapable: row.isolationCapable,
    version: row.version,
  }));
}
