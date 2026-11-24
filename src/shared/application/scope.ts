import { Types, type ClientSession } from 'mongoose';
import type { CommandActor } from '../domain/healthcare.js';
import type { OrgPermission } from '../../modules/access/access.constants.js';
import { authorizeOrganization, lockMembership } from '../../modules/access/access.service.js';
import { NumberSequence } from '../../modules/operations/operation.model.js';

/** A user command or an allowlisted background service identity. */
export type OperationActor = CommandActor | { serviceId: string; requestId: string };

export const actorRef = (actor: OperationActor) =>
  'userId' in actor
    ? { kind: 'USER' as const, id: actor.userId }
    : { kind: 'SERVICE' as const, id: actor.serviceId };

export const serviceActor = (serviceId: string, requestId: string): OperationActor => ({
  serviceId,
  requestId,
});

/**
 * Re-authorizes inside the transaction and writes the membership fence, so a concurrent
 * suspension or revocation serializes with the mutation that relies on it.
 */
export async function scoped(
  actor: CommandActor,
  organizationId: string,
  permission: OrgPermission,
  session: ClientSession,
  options: { facilityId?: string; organizationWide?: boolean; activeProvider?: boolean } = {},
) {
  const scope = await authorizeOrganization(actor, organizationId, permission, {
    ...options,
    session,
  });
  await lockMembership(scope.membership._id, session);
  return scope;
}

type Membership = Awaited<ReturnType<typeof authorizeOrganization>>['membership'];
/** Restricts facility-scoped members to their selected facilities. */
export function facilityFilter(membership: Membership, field = 'facilityId') {
  return membership.facilityScope === 'SELECTED'
    ? { [field]: { $in: membership.facilityIds } }
    : {};
}

export const before = (cursor?: string) =>
  cursor ? { _id: { $lt: new Types.ObjectId(cursor) } } : {};

export function pageOf<T extends { _id: Types.ObjectId }, R>(
  rows: T[],
  limit: number,
  present: (row: T) => R,
): { items: R[]; nextCursor?: string } {
  return {
    items: rows.slice(0, limit).map(present),
    nextCursor: rows.length > limit ? String(rows[limit - 1]!._id) : undefined,
  };
}

/** Default allowlisted presenter: identifiers become strings, internal fences are removed. */
export function presentRow<T extends { _id: Types.ObjectId }>(row: T) {
  const { _id, ...rest } = row as T & { authorizationFence?: number; schemaVersion?: number };
  delete (rest as { authorizationFence?: number }).authorizationFence;
  return { id: String(_id), ...rest };
}

/**
 * Atomic per-organization counter. Numbers are unique and never reused but need not be gapless.
 * The upsert participates in the caller's transaction; concurrent first use retries as a
 * transient write conflict.
 */
export async function nextNumber(
  organizationId: string | Types.ObjectId,
  kind: string,
  session: ClientSession,
): Promise<number> {
  const sequence = await NumberSequence.findOneAndUpdate(
    { organizationId, kind },
    { $inc: { nextValue: 1 } },
    { returnDocument: 'after', upsert: true, session },
  );
  return sequence!.nextValue;
}

export function formatNumber(prefix: string, value: number, width = 8): string {
  return `${prefix}-${String(value).padStart(width, '0')}`;
}

/** Indian fiscal year label (April–March), e.g. 2026-27. */
export function fiscalYear(date = new Date()): string {
  const local = new Date(date.getTime() + 330 * 60_000);
  const year = local.getUTCMonth() >= 3 ? local.getUTCFullYear() : local.getUTCFullYear() - 1;
  return `${year}-${String((year + 1) % 100).padStart(2, '0')}`;
}
