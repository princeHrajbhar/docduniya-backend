import type { ClientSession } from 'mongoose';
import type { z } from 'zod';
import type { CommandActor } from '../../shared/domain/healthcare.js';
import { todayInIndia } from '../../shared/domain/healthcare.js';
import { command, conflict } from '../../shared/application/command.js';
import {
  actorRef,
  before,
  nextNumber,
  pageOf,
  scoped,
  type OperationActor,
} from '../../shared/application/scope.js';
import { authorizeOrganization } from '../access/access.service.js';
import { ApiError } from '../../utils/api-error.js';
import { recordChange } from '../operations/operation.service.js';
import { lockActiveFacility } from '../organizations/organization.repository.js';
import { PatientRegistration } from '../patients/patient.model.js';
import { QueueEntry } from './appointment.model.js';
import type { walkInInput, queueTransitionInput, queueQuery } from './appointment.validation.js';

const PRIORITY_ORDER = { EMERGENCY: 0, URGENT: 1, ROUTINE: 2 } as const;

/** Allocates a facility/day token atomically (never count + 1) and records the arrival. */
export async function enqueue(
  actor: OperationActor,
  entry: {
    organizationId: string;
    facilityId: string;
    patientId: string;
    patientRegistrationId: string;
    appointmentId?: string;
    priority?: 'ROUTINE' | 'URGENT' | 'EMERGENCY';
    priorityReason?: string;
  },
  session: ClientSession,
) {
  const localDay = todayInIndia();
  const tokenNumber = await nextNumber(
    entry.organizationId,
    `QUEUE:${entry.facilityId}:${localDay}`,
    session,
  );
  const who = actorRef(actor);
  const [row] = await QueueEntry.create(
    [{ ...entry, localDay, tokenNumber, arrivedAt: new Date(), createdBy: who, updatedBy: who }],
    { session },
  );
  await recordChange(
    actor,
    {
      organizationId: entry.organizationId,
      patientId: entry.patientId,
      action: 'QueueEntryCreated',
      resourceType: 'queueEntry',
      resourceId: String(row!._id),
      version: 0,
    },
    session,
  );
  return row!;
}

export async function addWalkIn(
  actor: CommandActor,
  organizationId: string,
  input: z.infer<typeof walkInInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'queue.manage', {
    facilityId: input.facilityId,
  });
  if (input.priority !== 'ROUTINE' && !input.priorityReason)
    throw ApiError.badRequest('A priority reason is required');
  return command(actor, organizationId, 'queue.walk-in', key, input, async (session) => {
    await scoped(actor, organizationId, 'queue.manage', session, {
      facilityId: input.facilityId,
      activeProvider: true,
    });
    await lockActiveFacility(organizationId, input.facilityId, session);
    const registration = await PatientRegistration.findOne({
      _id: input.patientRegistrationId,
      organizationId,
      status: 'ACTIVE',
    }).session(session);
    if (!registration) throw ApiError.notFound('Patient registration is unavailable');
    const row = await enqueue(
      actor,
      {
        organizationId,
        facilityId: input.facilityId,
        patientId: String(registration.patientId),
        patientRegistrationId: String(registration._id),
        priority: input.priority,
        priorityReason: input.priorityReason,
      },
      session,
    );
    return { id: String(row._id), version: row.version };
  });
}

const TRANSITIONS = {
  call: { from: ['WAITING', 'CALLED'], to: 'CALLED' },
  serve: { from: ['CALLED'], to: 'IN_SERVICE' },
  done: { from: ['IN_SERVICE'], to: 'DONE' },
  left: { from: ['WAITING', 'CALLED'], to: 'LEFT' },
  prioritize: { from: ['WAITING', 'CALLED'], to: undefined },
} as const;

export async function transitionQueue(
  actor: CommandActor,
  organizationId: string,
  entryId: string,
  input: z.infer<typeof queueTransitionInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'queue.manage');
  if (input.action === 'prioritize' && (!input.priority || !input.reason))
    throw ApiError.badRequest('Priority changes require a priority and reason');
  const operation = `queue.${input.action}:${entryId}`;
  return command(actor, organizationId, operation, key, input, async (session) => {
    const entry = await QueueEntry.findOne({
      _id: entryId,
      organizationId,
      version: input.expectedVersion,
    }).session(session);
    if (!entry) conflict();
    await scoped(actor, organizationId, 'queue.manage', session, {
      facilityId: String(entry.facilityId),
    });
    const rule = TRANSITIONS[input.action];
    if (!(rule.from as readonly string[]).includes(entry.status))
      conflict('Queue entry cannot make this transition');
    const now = new Date();
    if (rule.to === undefined) {
      // Priority changes are audited and never alter the arrival time or appointment time.
      entry.priority = input.priority!;
      entry.priorityReason = input.reason;
    } else {
      entry.status = rule.to;
      if (input.action === 'call') entry.calledAt = now;
      if (input.action === 'serve') entry.servedAt = now;
      if (input.action === 'done' || input.action === 'left') entry.closedAt = now;
    }
    entry.updatedBy = { kind: 'USER', id: actor.userId };
    await entry.save({ session });
    await recordChange(
      actor,
      {
        organizationId,
        patientId: String(entry.patientId),
        action: `QueueEntry.${input.action}`,
        resourceType: 'queueEntry',
        resourceId: entryId,
        version: entry.version,
        reason: input.reason,
      },
      session,
    );
    return { id: entryId, version: entry.version };
  });
}

export async function listQueue(
  actor: CommandActor,
  organizationId: string,
  query: z.infer<typeof queueQuery>,
) {
  // Facility-scoped members are checked against the requested facility here.
  await authorizeOrganization(actor, organizationId, 'queue.manage', {
    facilityId: query.facilityId,
  });
  const rows = await QueueEntry.find({
    organizationId,
    facilityId: query.facilityId,
    localDay: query.date ?? todayInIndia(),
    ...(query.status ? { status: query.status } : {}),
    ...before(query.before),
  })
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean();
  const result = pageOf(rows, query.limit, (row) => ({
    id: String(row._id),
    tokenNumber: row.tokenNumber,
    patientRegistrationId: String(row.patientRegistrationId),
    appointmentId: row.appointmentId ? String(row.appointmentId) : undefined,
    priority: row.priority,
    priorityReason: row.priorityReason,
    status: row.status,
    arrivedAt: row.arrivedAt,
    calledAt: row.calledAt,
    version: row.version,
  }));
  // Service order within the page: priority first, then arrival. Tokens never change.
  result.items.sort(
    (a, b) =>
      PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
      a.arrivedAt.getTime() - b.arrivedAt.getTime(),
  );
  return result;
}
