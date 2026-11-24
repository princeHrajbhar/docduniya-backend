import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import type { CommandActor } from '../../shared/domain/healthcare.js';
import { AuditEvent, OutboxEvent, NumberSequence } from './operation.model.js';

export interface Change {
  organizationId?: string;
  patientId?: string;
  action: string;
  resourceType: string;
  resourceId: string;
  version: number;
  reason?: string;
}
export async function recordChange(
  actor: CommandActor | { serviceId: string; requestId: string },
  change: Change,
  session: ClientSession,
): Promise<void> {
  const who =
    'userId' in actor
      ? { kind: 'USER' as const, id: actor.userId }
      : { kind: 'SERVICE' as const, id: actor.serviceId };
  const { version: resourceVersion, ...auditFields } = change;
  await AuditEvent.create(
    [{ ...auditFields, actor: who, outcome: 'SUCCESS', requestId: actor.requestId }],
    { session },
  );
  await OutboxEvent.create(
    [
      {
        eventId: randomUUID(),
        organizationId: change.organizationId,
        type: change.action,
        aggregateType: change.resourceType,
        aggregateId: change.resourceId,
        aggregateVersion: resourceVersion,
        actor: who,
        correlationId: actor.requestId,
      },
    ],
    { session },
  );
}
export async function recordRead(
  actor: CommandActor,
  resourceType: string,
  resourceId: string,
  organizationId?: string,
  patientId?: string,
): Promise<void> {
  await AuditEvent.create({
    actor: { kind: 'USER', id: actor.userId },
    action: `${resourceType}.read`,
    resourceType,
    resourceId,
    organizationId,
    patientId,
    outcome: 'ALLOW',
    requestId: actor.requestId,
  });
}
export async function nextMrn(organizationId: string, session: ClientSession): Promise<string> {
  const sequence = await NumberSequence.findOneAndUpdate(
    { organizationId, kind: 'MRN' },
    { $inc: { nextValue: 1 } },
    { returnDocument: 'after', session },
  );
  if (!sequence)
    throw new Error('Organization MRN counter is missing; run the foundation migration');
  return `MRN-${String(sequence.nextValue).padStart(8, '0')}`;
}
