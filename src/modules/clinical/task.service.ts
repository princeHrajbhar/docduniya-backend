import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import type { z } from 'zod';
import type { CommandActor } from '../../shared/domain/healthcare.js';
import { command, conflict, transaction } from '../../shared/application/command.js';
import {
  actorRef,
  before,
  pageOf,
  scoped,
  serviceActor,
  type OperationActor,
} from '../../shared/application/scope.js';
import { stamp } from '../../shared/persistence/schema.js';
import { ApiError } from '../../utils/api-error.js';
import { authorizeOrganization } from '../access/access.service.js';
import { Organization } from '../organizations/organization.model.js';
import { Practitioner } from '../practitioners/practitioner.model.js';
import { recordChange } from '../operations/operation.service.js';
import { authorizeClinical, ownPractitioner } from './clinical.policy.js';
import { encounterForWrite, provenance } from './encounter.service.js';
import { ClinicalTask, Referral } from './clinical.model.js';
import type {
  referralInput,
  referralResponseInput,
  taskInput,
  taskQuery,
  taskTransitionInput,
} from './clinical.validation.js';

/** Escalation interval for unacknowledged work by priority. */
const ESCALATION_MINUTES = { CRITICAL: 30, URGENT: 240, ROUTINE: 24 * 60 } as const;

export async function createTaskInternal(
  actor: OperationActor,
  task: {
    organizationId: string;
    patientId: string;
    patientRegistrationId: string;
    kind: 'FOLLOW_UP' | 'RESULT_REVIEW' | 'CRITICAL_RESULT' | 'REFERRAL' | 'NURSING' | 'OTHER';
    title: string;
    sourceRef: { type: string; id: string };
    assigneeId?: string;
    dueAt: Date;
    priority: 'ROUTINE' | 'URGENT' | 'CRITICAL';
  },
  session: ClientSession,
) {
  const who = actorRef(actor);
  const [row] = await ClinicalTask.create(
    [
      {
        ...task,
        nextEscalationAt: new Date(Date.now() + ESCALATION_MINUTES[task.priority] * 60_000),
        createdBy: who,
        updatedBy: who,
      },
    ],
    { session },
  );
  await recordChange(
    actor,
    {
      organizationId: task.organizationId,
      patientId: task.patientId,
      action: task.kind === 'CRITICAL_RESULT' ? 'CriticalResultTaskCreated' : 'ClinicalTaskCreated',
      resourceType: 'clinicalTask',
      resourceId: String(row!._id),
      version: 0,
    },
    session,
  );
  return row!;
}

export async function createTask(
  actor: CommandActor,
  organizationId: string,
  input: z.infer<typeof taskInput>,
  key: string,
) {
  return command(actor, organizationId, 'task.create', key, input, async (session) => {
    const { registration } = await authorizeClinical(
      actor,
      organizationId,
      input.patientId,
      'clinical.write',
      { session },
    );
    let assigneeId: string | undefined;
    if (input.assigneeUserId) {
      const assignee = await Practitioner.findOne({
        userId: input.assigneeUserId,
        status: 'ACTIVE',
      }).session(session);
      if (!assignee) throw ApiError.notFound('Assignee has no professional profile');
      await authorizeOrganization(
        { userId: input.assigneeUserId, requestId: actor.requestId },
        organizationId,
        'clinical.read',
        { session },
      );
      assigneeId = String(assignee._id);
    }
    const task = await createTaskInternal(
      actor,
      {
        organizationId,
        patientId: input.patientId,
        patientRegistrationId: String(registration._id),
        kind: input.kind,
        title: input.title,
        sourceRef: input.sourceRef,
        assigneeId,
        dueAt: new Date(input.dueAt),
        priority: input.priority,
      },
      session,
    );
    return { id: String(task._id), version: task.version };
  });
}

/** Acknowledgement and completion are distinct facts; a sent alert proves neither. */
export async function transitionTask(
  actor: CommandActor,
  organizationId: string,
  taskId: string,
  input: z.infer<typeof taskTransitionInput>,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `task.${input.action}:${taskId}`,
    key,
    input,
    async (session) => {
      const task = await ClinicalTask.findOne({
        _id: taskId,
        organizationId,
        version: input.expectedVersion,
      }).session(session);
      if (!task) conflict();
      const { practitioner } = await authorizeClinical(
        actor,
        organizationId,
        String(task.patientId),
        'clinical.read',
        { session },
      );
      if (
        task.assigneeId &&
        String(task.assigneeId) !== String(practitioner._id) &&
        input.action !== 'cancel'
      )
        throw ApiError.forbidden('This task is assigned to another clinician');
      const allowed = {
        acknowledge: ['OPEN'],
        start: ['OPEN', 'ACKNOWLEDGED'],
        complete: ['ACKNOWLEDGED', 'IN_PROGRESS'],
        cancel: ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS'],
      }[input.action];
      if (!allowed.includes(task.status)) conflict('The task cannot make this transition');
      if (task.kind === 'CRITICAL_RESULT' && input.action === 'cancel')
        throw ApiError.forbidden('Critical results must be acknowledged and completed');
      if (input.action === 'complete' && !input.outcome)
        throw ApiError.badRequest('Record the outcome');
      const now = new Date();
      if (input.action === 'acknowledge' || (input.action === 'start' && task.status === 'OPEN')) {
        task.acknowledgedAt = now;
        task.acknowledgedBy = practitioner._id;
      }
      task.status = {
        acknowledge: 'ACKNOWLEDGED',
        start: 'IN_PROGRESS',
        complete: 'DONE',
        cancel: 'CANCELLED',
      }[input.action] as typeof task.status;
      if (input.action === 'complete') task.completedAt = now;
      task.outcome = input.outcome ?? task.outcome;
      task.nextEscalationAt = undefined;
      task.updatedBy = { kind: 'USER', id: actor.userId };
      await task.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          patientId: String(task.patientId),
          action: `ClinicalTask.${input.action}`,
          resourceType: 'clinicalTask',
          resourceId: taskId,
          version: task.version,
        },
        session,
      );
      return { id: taskId, version: task.version };
    },
  );
}

export async function listTasks(
  actor: CommandActor,
  organizationId: string,
  query: z.infer<typeof taskQuery>,
) {
  await authorizeOrganization(actor, organizationId, 'clinical.read');
  const practitioner = await ownPractitioner(actor);
  const rows = await ClinicalTask.find({
    organizationId,
    ...(query.mine === 'true' ? { assigneeId: practitioner._id } : {}),
    ...(query.status
      ? { status: query.status }
      : { status: { $in: ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS'] } }),
    ...before(query.before),
  })
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean();
  return pageOf(rows, query.limit, (row) => ({
    id: String(row._id),
    patientId: String(row.patientId),
    kind: row.kind,
    title: row.title,
    sourceRef: { type: row.sourceRef.type, id: String(row.sourceRef.id) },
    priority: row.priority,
    status: row.status,
    dueAt: row.dueAt,
    escalationLevel: row.escalationLevel,
    acknowledgedAt: row.acknowledgedAt,
    version: row.version,
  }));
}

/** Raises the escalation level of unacknowledged tasks; delivery is handled by notification consumers. */
export async function escalateOverdueTasks(limit = 100): Promise<number> {
  const due = await ClinicalTask.find({
    status: 'OPEN',
    nextEscalationAt: { $lte: new Date() },
  }).limit(limit);
  for (const task of due)
    await transaction(async (session) => {
      const current = await ClinicalTask.findOne({
        _id: task._id,
        version: task.version,
        status: 'OPEN',
      }).session(session);
      if (!current) return;
      current.escalationLevel = Math.min(current.escalationLevel + 1, 10);
      current.nextEscalationAt = new Date(
        Date.now() + ESCALATION_MINUTES[current.priority] * 60_000,
      );
      current.updatedBy = { kind: 'SERVICE', id: 'task-escalation' };
      await current.save({ session });
      await recordChange(
        serviceActor('task-escalation', randomUUID()),
        {
          organizationId: String(current.organizationId),
          patientId: String(current.patientId),
          action: 'ClinicalTaskEscalated',
          resourceType: 'clinicalTask',
          resourceId: String(current._id),
          version: current.version,
        },
        session,
      );
    });
  return due.length;
}

// ── Referrals ────────────────────────────────────────────────────────────────

/** A referral transfers responsibility, not records: sharing still needs the patient's consent. */
export async function createReferral(
  actor: CommandActor,
  organizationId: string,
  encounterId: string,
  input: z.infer<typeof referralInput>,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `referral.create:${encounterId}`,
    key,
    input,
    async (session) => {
      const { encounter, practitioner } = await encounterForWrite(
        actor,
        organizationId,
        encounterId,
        session,
      );
      if (
        input.toOrganizationId &&
        !(await Organization.exists({ _id: input.toOrganizationId, status: 'ACTIVE' }).session(
          session,
        ))
      )
        throw ApiError.notFound('Receiving provider is unavailable');
      const [referral] = await Referral.create(
        [
          {
            ...stamp(actor.userId),
            organizationId,
            patientId: encounter.patientId,
            patientRegistrationId: encounter.patientRegistrationId,
            encounterId,
            provenance: provenance(actor),
            fromPractitionerId: practitioner._id,
            ...input,
            status: 'SENT',
          },
        ],
        { session },
      );
      await recordChange(
        actor,
        {
          organizationId,
          patientId: String(encounter.patientId),
          action: 'ReferralSent',
          resourceType: 'referral',
          resourceId: String(referral!._id),
          version: 0,
        },
        session,
      );
      return { id: String(referral!._id), version: 0 };
    },
  );
}

export async function listIncomingReferrals(
  actor: CommandActor,
  organizationId: string,
  page: { before?: string; limit: number },
) {
  await authorizeOrganization(actor, organizationId, 'appointments.read');
  const rows = await Referral.find({
    toOrganizationId: organizationId,
    status: { $in: ['SENT', 'ACCEPTED'] },
    ...before(page.before),
  })
    .sort({ _id: -1 })
    .limit(page.limit + 1)
    .lean();
  // Minimum necessary: the receiving provider sees the reason and priority, not the chart.
  return pageOf(rows, page.limit, (row) => ({
    id: String(row._id),
    patientId: String(row.patientId),
    fromOrganizationId: String(row.organizationId),
    reason: row.reason,
    priority: row.priority,
    status: row.status,
    version: row.version,
  }));
}

export async function respondToReferral(
  actor: CommandActor,
  organizationId: string,
  referralId: string,
  input: z.infer<typeof referralResponseInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'appointments.manage');
  return command(
    actor,
    organizationId,
    `referral.respond:${referralId}`,
    key,
    input,
    async (session) => {
      await scoped(actor, organizationId, 'appointments.manage', session);
      const referral = await Referral.findOne({
        _id: referralId,
        toOrganizationId: organizationId,
        version: input.expectedVersion,
      }).session(session);
      if (!referral) conflict();
      const next = {
        ACCEPT: ['SENT', 'ACCEPTED'],
        DECLINE: ['SENT', 'DECLINED'],
        COMPLETE: ['ACCEPTED', 'COMPLETED'],
      }[input.decision];
      if (referral.status !== next[0]) conflict('The referral cannot make this transition');
      referral.status = next[1] as typeof referral.status;
      referral.respondedAt = new Date();
      referral.responseReason = input.reason;
      referral.updatedBy = { kind: 'USER', id: actor.userId };
      await referral.save({ session });
      await recordChange(
        actor,
        {
          organizationId: String(referral.organizationId),
          patientId: String(referral.patientId),
          action: `Referral.${input.decision}`,
          resourceType: 'referral',
          resourceId: referralId,
          version: referral.version,
          reason: input.reason,
        },
        session,
      );
      return { id: referralId, version: referral.version };
    },
  );
}
