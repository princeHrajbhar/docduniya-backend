import type { ClientSession } from 'mongoose';
import { ApiError } from '../../utils/api-error.js';
import { Organization, Facility } from './organization.model.js';

export async function organizationForScope(id: string, session?: ClientSession) {
  const organization = await Organization.findById(id)
    .session(session ?? null)
    .lean();
  if (!organization || ['CLOSED', 'OFFBOARDING', 'SUSPENDED'].includes(organization.status))
    throw ApiError.notFound('Organization is unavailable');
  return organization;
}
export async function assertFacilities(
  organizationId: string,
  facilityIds: string[],
  session?: ClientSession,
): Promise<void> {
  if (new Set(facilityIds).size !== facilityIds.length)
    throw ApiError.badRequest('Duplicate facility identifiers');
  const count = await Facility.countDocuments({
    _id: { $in: facilityIds },
    organizationId,
    status: { $ne: 'INACTIVE' },
  }).session(session ?? null);
  if (count !== facilityIds.length) throw ApiError.notFound('Facility is unavailable');
}

export async function lockActiveFacility(
  organizationId: string,
  facilityId: string,
  session: ClientSession,
): Promise<void> {
  const result = await Facility.updateOne(
    { _id: facilityId, organizationId, status: 'ACTIVE' },
    { $inc: { authorizationFence: 1 } },
    { session },
  );
  if (!result.matchedCount) throw ApiError.notFound('Active facility is unavailable');
}
