import type { ClientSession } from 'mongoose';
import { z } from 'zod';
import type { CommandActor } from '../../shared/domain/healthcare.js';
import { objectId } from '../../shared/domain/healthcare.js';
import { command, conflict } from '../../shared/application/command.js';
import {
  facilityFilter,
  formatNumber,
  nextNumber,
  scoped,
} from '../../shared/application/scope.js';
import { ApiError } from '../../utils/api-error.js';
import { stamp } from '../../shared/persistence/schema.js';
import { authorizeOrganization } from '../access/access.service.js';
import { recordChange, recordRead } from '../operations/operation.service.js';
import { FacilityLocation } from '../locations/location.model.js';
import { Practitioner } from '../practitioners/practitioner.model.js';
import { conceptInput } from '../clinical/clinical.validation.js';
import { ClinicalNote } from '../clinical/clinical.model.js';
import { authorizeClinical, currentClinicalCredential } from '../clinical/clinical.policy.js';
import { encounterForWrite, ensureCareAssignment } from '../clinical/encounter.service.js';
import { Admission } from '../inpatient/inpatient.model.js';
import { CHECKLIST, ProcedureCase, TheatreLock, type ChecklistPhase } from './procedure.model.js';

const version = z.number().int().min(0);
export const procedureRequestInput = z.strictObject({
  encounterId: objectId,
  admissionId: objectId.optional(),
  procedure: conceptInput,
  laterality: z.enum(['LEFT', 'RIGHT', 'BILATERAL', 'NOT_APPLICABLE']),
  priority: z.enum(['ELECTIVE', 'URGENT', 'EMERGENCY']),
  estimatedMinutes: z.number().int().min(10).max(1440),
});
export const scheduleInput = z.strictObject({
  expectedVersion: version,
  theatreId: objectId,
  scheduledStart: z.iso.datetime(),
  team: z
    .array(
      z.strictObject({
        userId: objectId,
        role: z.enum(['SURGEON', 'ASSISTANT', 'ANAESTHETIST', 'SCRUB_NURSE', 'CIRCULATING_NURSE']),
      }),
    )
    .min(1)
    .max(12)
    .refine((team) => team.some((member) => member.role === 'SURGEON'), {
      message: 'The team needs a surgeon',
    })
    .refine((team) => new Set(team.map((member) => member.userId)).size === team.length, {
      message: 'List each team member once',
    }),
});
export const checklistInput = z.strictObject({
  expectedVersion: version,
  confirmed: z.array(z.string().trim().min(3).max(60)).min(1).max(20),
  notes: z.string().trim().max(1000).optional(),
});
export const completionInput = z.strictObject({
  expectedVersion: version,
  outcomeSummary: z.string().trim().min(10).max(4000),
  operativeNoteId: objectId.optional(),
});
export const cancelProcedureInput = z.strictObject({
  expectedVersion: version,
  reason: z.string().trim().min(10).max(1000),
});
export const theatreQuery = z.strictObject({
  facilityId: objectId,
  date: z.iso.date(),
});

const who = (actor: CommandActor) => ({ kind: 'USER' as const, id: actor.userId });
type CaseRow = ReturnType<typeof ProcedureCase.hydrate>;

/** The indicating clinician (care team, current credential) requests a theatre case. */
export async function requestProcedure(
  actor: CommandActor,
  organizationId: string,
  input: z.infer<typeof procedureRequestInput>,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `procedure.request:${input.encounterId}`,
    key,
    input,
    async (session) => {
      const { encounter, practitioner } = await encounterForWrite(
        actor,
        organizationId,
        input.encounterId,
        session,
        'clinical.sign',
      );
      if (input.admissionId) {
        const admission = await Admission.exists({
          _id: input.admissionId,
          organizationId,
          patientId: encounter.patientId,
          status: { $in: ['REQUESTED', 'ADMITTED', 'DISCHARGE_PLANNED'] },
        }).session(session);
        if (!admission) throw ApiError.notFound('Admission is unavailable');
      }
      const [row] = await ProcedureCase.create(
        [
          {
            ...stamp(actor.userId),
            organizationId,
            facilityId: encounter.facilityId,
            patientId: encounter.patientId,
            patientRegistrationId: encounter.patientRegistrationId,
            encounterId: encounter._id,
            admissionId: input.admissionId,
            number: formatNumber('OT', await nextNumber(organizationId, 'PROCEDURE', session)),
            procedure: input.procedure,
            laterality: input.laterality,
            priority: input.priority,
            requestedBy: practitioner._id,
            estimatedMinutes: input.estimatedMinutes,
          },
        ],
        { session },
      );
      await recordChange(
        actor,
        {
          organizationId,
          patientId: String(encounter.patientId),
          action: 'ProcedureRequested',
          resourceType: 'procedureCase',
          resourceId: String(row!._id),
          version: 0,
        },
        session,
      );
      return { id: String(row!._id), version: 0 };
    },
  );
}

async function caseFor(
  organizationId: string,
  caseId: string,
  expectedVersion: number,
  session: ClientSession,
) {
  const row = await ProcedureCase.findOne({
    _id: caseId,
    organizationId,
    version: expectedVersion,
  }).session(session);
  if (!row) conflict();
  return row;
}

/**
 * Theatre coordination: books a theatre slot without overlap and assembles the team. Each team
 * member gets a care relationship for the patient, so the team can read the chart.
 */
export async function scheduleProcedure(
  actor: CommandActor,
  organizationId: string,
  caseId: string,
  input: z.infer<typeof scheduleInput>,
  key: string,
) {
  await TheatreLock.updateOne(
    { theatreId: input.theatreId },
    { $setOnInsert: { fence: 0 } },
    { upsert: true },
  );
  return command(
    actor,
    organizationId,
    `procedure.schedule:${caseId}`,
    key,
    input,
    async (session) => {
      const row = await caseFor(organizationId, caseId, input.expectedVersion, session);
      if (!['REQUESTED', 'SCHEDULED'].includes(row.status))
        conflict('The case can no longer be scheduled');
      await scoped(actor, organizationId, 'inpatient.manage', session, {
        facilityId: String(row.facilityId),
        activeProvider: true,
      });
      const theatre = await FacilityLocation.findOne({
        _id: input.theatreId,
        organizationId,
        facilityId: row.facilityId,
        kind: 'THEATRE',
        operationalStatus: { $nin: ['CLOSED', 'MAINTENANCE'] },
      }).session(session);
      if (!theatre) throw ApiError.notFound('Theatre is unavailable at this facility');
      const start = new Date(input.scheduledStart);
      if (start <= new Date()) throw ApiError.badRequest('Schedule the case in the future');
      const end = new Date(start.getTime() + row.estimatedMinutes * 60_000);
      // Writing the lock serializes concurrent bookings of the same theatre.
      await TheatreLock.updateOne({ theatreId: theatre._id }, { $inc: { fence: 1 } }, { session });
      const overlap = await ProcedureCase.exists({
        _id: { $ne: row._id },
        theatreId: theatre._id,
        status: { $in: ['SCHEDULED', 'IN_THEATRE'] },
        scheduledStart: { $lt: end },
        scheduledEnd: { $gt: start },
      }).session(session);
      if (overlap) conflict('The theatre is booked at that time');
      const team = [];
      for (const member of input.team) {
        const practitioner = await Practitioner.findOne({
          userId: member.userId,
          status: 'ACTIVE',
        }).session(session);
        if (!practitioner)
          throw ApiError.badRequest('Every team member needs a professional profile');
        if (member.role === 'SURGEON' && practitioner.profession !== 'DOCTOR')
          throw ApiError.badRequest('The surgeon must be a doctor');
        await ensureCareAssignment(
          actor,
          {
            organizationId,
            patientId: String(row.patientId),
            patientRegistrationId: String(row.patientRegistrationId),
            facilityId: String(row.facilityId),
            practitionerId: String(practitioner._id),
            userId: member.userId,
            roleCode:
              member.role === 'SURGEON'
                ? 'ATTENDING'
                : member.role.endsWith('NURSE')
                  ? 'NURSING'
                  : 'CONSULTING',
          },
          session,
        );
        team.push({ userId: member.userId, practitionerId: practitioner._id, role: member.role });
      }
      row.set({
        theatreId: theatre._id,
        scheduledStart: start,
        scheduledEnd: end,
        team,
        status: 'SCHEDULED',
        updatedBy: who(actor),
      });
      await row.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          patientId: String(row.patientId),
          action: 'ProcedureScheduled',
          resourceType: 'procedureCase',
          resourceId: caseId,
          version: row.version,
        },
        session,
      );
      return { id: caseId, version: row.version };
    },
  );
}

/** Team members only, with clinical write access to the patient at the case facility. */
async function teamMember(actor: CommandActor, row: CaseRow, session: ClientSession) {
  const member = row.team.find((entry) => String(entry.userId) === actor.userId);
  if (!member) throw ApiError.forbidden('Only the theatre team records this case');
  const access = await authorizeClinical(
    actor,
    String(row.organizationId),
    String(row.patientId),
    'clinical.write',
    {
      session,
      facilityId: String(row.facilityId),
    },
  );
  return { member, practitioner: access.practitioner };
}

const PHASE_FIELD = { SIGN_IN: 'signIn', TIME_OUT: 'timeOut', SIGN_OUT: 'signOut' } as const;
const PHASE_ORDER: ChecklistPhase[] = ['SIGN_IN', 'TIME_OUT', 'SIGN_OUT'];

/**
 * Records one checklist phase. Every required item must be confirmed; phases run in order:
 * sign-in and time-out before incision, sign-out before the patient leaves theatre.
 */
export async function completeChecklist(
  actor: CommandActor,
  organizationId: string,
  caseId: string,
  phase: ChecklistPhase,
  input: z.infer<typeof checklistInput>,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `procedure.${phase}:${caseId}`,
    key,
    input,
    async (session) => {
      const row = await caseFor(organizationId, caseId, input.expectedVersion, session);
      const { practitioner } = await teamMember(actor, row, session);
      const allowed = phase === 'SIGN_OUT' ? ['IN_THEATRE'] : ['SCHEDULED'];
      if (!allowed.includes(row.status)) conflict(`The ${phase} phase is not open for this case`);
      const index = PHASE_ORDER.indexOf(phase);
      for (const earlier of PHASE_ORDER.slice(0, index))
        if (!row[PHASE_FIELD[earlier]]) conflict(`Complete ${earlier} first`);
      if (row[PHASE_FIELD[phase]]) conflict(`${phase} is already recorded`);
      const required: readonly string[] = CHECKLIST[phase];
      const missing = required.filter((item) => !input.confirmed.includes(item));
      const unknown = input.confirmed.filter((item) => !required.includes(item));
      if (missing.length || unknown.length)
        throw ApiError.badRequest('Confirm every checklist item for this phase', {
          missing,
          unknown,
        });
      row.set({
        [PHASE_FIELD[phase]]: {
          completedAt: new Date(),
          completedBy: practitioner._id,
          confirmed: input.confirmed,
          notes: input.notes,
        },
        updatedBy: who(actor),
      });
      await row.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          patientId: String(row.patientId),
          action: `ProcedureChecklist${phase}`,
          resourceType: 'procedureCase',
          resourceId: caseId,
          version: row.version,
        },
        session,
      );
      return { id: caseId, version: row.version };
    },
  );
}

/** Incision only after sign-in and time-out; the operating surgeon must hold a current credential. */
export async function startProcedure(
  actor: CommandActor,
  organizationId: string,
  caseId: string,
  expectedVersion: number,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `procedure.start:${caseId}`,
    key,
    { expectedVersion },
    async (session) => {
      const row = await caseFor(organizationId, caseId, expectedVersion, session);
      const { member } = await teamMember(actor, row, session);
      if (member.role !== 'SURGEON') throw ApiError.forbidden('The surgeon starts the procedure');
      if (row.status !== 'SCHEDULED') conflict('Only scheduled cases start');
      if (!row.signIn || !row.timeOut) conflict('Complete sign-in and time-out before starting');
      await currentClinicalCredential(actor, organizationId, String(row.facilityId), session);
      row.set({ status: 'IN_THEATRE', actualStart: new Date(), updatedBy: who(actor) });
      await row.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          patientId: String(row.patientId),
          action: 'ProcedureStarted',
          resourceType: 'procedureCase',
          resourceId: caseId,
          version: row.version,
        },
        session,
      );
      return { id: caseId, version: row.version };
    },
  );
}

export async function completeProcedure(
  actor: CommandActor,
  organizationId: string,
  caseId: string,
  input: z.infer<typeof completionInput>,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `procedure.complete:${caseId}`,
    key,
    input,
    async (session) => {
      const row = await caseFor(organizationId, caseId, input.expectedVersion, session);
      const { member } = await teamMember(actor, row, session);
      if (member.role !== 'SURGEON') throw ApiError.forbidden('The surgeon completes the case');
      if (row.status !== 'IN_THEATRE') conflict('Only cases in theatre complete');
      if (!row.signOut) conflict('Complete sign-out before closing the case');
      if (input.operativeNoteId) {
        const note = await ClinicalNote.exists({
          _id: input.operativeNoteId,
          organizationId,
          encounterId: row.encounterId,
          noteType: 'PROCEDURE',
        }).session(session);
        if (!note) throw ApiError.badRequest('Link a procedure note of this encounter');
      }
      row.set({
        status: 'COMPLETED',
        actualEnd: new Date(),
        outcomeSummary: input.outcomeSummary,
        operativeNoteId: input.operativeNoteId,
        updatedBy: who(actor),
      });
      await row.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          patientId: String(row.patientId),
          action: 'ProcedureCompleted',
          resourceType: 'procedureCase',
          resourceId: caseId,
          version: row.version,
        },
        session,
      );
      return { id: caseId, version: row.version };
    },
  );
}

export async function cancelProcedure(
  actor: CommandActor,
  organizationId: string,
  caseId: string,
  input: z.infer<typeof cancelProcedureInput>,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `procedure.cancel:${caseId}`,
    key,
    input,
    async (session) => {
      const row = await caseFor(organizationId, caseId, input.expectedVersion, session);
      await scoped(actor, organizationId, 'inpatient.manage', session, {
        facilityId: String(row.facilityId),
      });
      if (!['REQUESTED', 'SCHEDULED'].includes(row.status))
        conflict('A case in theatre is completed, not cancelled');
      row.set({ status: 'CANCELLED', cancellationReason: input.reason, updatedBy: who(actor) });
      await row.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          patientId: String(row.patientId),
          action: 'ProcedureCancelled',
          resourceType: 'procedureCase',
          resourceId: caseId,
          version: row.version,
          reason: input.reason,
        },
        session,
      );
      return { id: caseId, version: row.version };
    },
  );
}

/** Theatre board for a day: times, theatre and status only; clinical detail needs chart access. */
export async function theatreSchedule(
  actor: CommandActor,
  organizationId: string,
  query: z.infer<typeof theatreQuery>,
) {
  const scope = await authorizeOrganization(actor, organizationId, 'inpatient.manage', {
    facilityId: query.facilityId,
  });
  const dayStart = new Date(`${query.date}T00:00:00+05:30`);
  const dayEnd = new Date(dayStart.getTime() + 86400_000);
  const rows = await ProcedureCase.find({
    organizationId,
    facilityId: query.facilityId,
    ...facilityFilter(scope.membership),
    status: { $in: ['SCHEDULED', 'IN_THEATRE', 'COMPLETED'] },
    scheduledStart: { $lt: dayEnd },
    scheduledEnd: { $gt: dayStart },
  })
    .sort({ scheduledStart: 1 })
    .lean();
  return {
    items: rows.map((row) => ({
      id: String(row._id),
      number: row.number,
      theatreId: String(row.theatreId),
      scheduledStart: row.scheduledStart,
      scheduledEnd: row.scheduledEnd,
      priority: row.priority,
      status: row.status,
      version: row.version,
    })),
  };
}

export async function getProcedure(actor: CommandActor, organizationId: string, caseId: string) {
  const row = await ProcedureCase.findOne({ _id: caseId, organizationId });
  if (!row) throw ApiError.notFound();
  await authorizeClinical(actor, organizationId, String(row.patientId), 'clinical.read', {
    facilityId: String(row.facilityId),
  });
  await recordRead(actor, 'procedureCase', caseId, organizationId, String(row.patientId));
  const { _id, ...rest } = row.toObject();
  return { id: String(_id), ...rest, checklist: CHECKLIST };
}
