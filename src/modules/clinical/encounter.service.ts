import type { ClientSession } from 'mongoose';
import type { z } from 'zod';
import type { CommandActor } from '../../shared/domain/healthcare.js';
import { command, conflict } from '../../shared/application/command.js';
import { before, pageOf, scoped } from '../../shared/application/scope.js';
import { stamp } from '../../shared/persistence/schema.js';
import { ApiError } from '../../utils/api-error.js';
import { Membership } from '../access/access.model.js';
import { recordChange, recordRead } from '../operations/operation.service.js';
import { lockActiveFacility } from '../organizations/organization.repository.js';
import { Appointment } from '../appointments/appointment.model.js';
import { Practitioner } from '../practitioners/practitioner.model.js';
import { Consent } from '../privacy/privacy.model.js';
import { authorizeClinical } from './clinical.policy.js';
import { CareTeamAssignment, Encounter, Visit } from './clinical.model.js';
import type {
  careTeamInput,
  encounterInput,
  encounterQuery,
  endCareInput,
} from './clinical.validation.js';

const provenance = (actor: CommandActor) => ({
  source: 'CLINICIAN' as const,
  recordedAt: new Date(),
  recordedBy: { kind: 'USER' as const, id: actor.userId },
});
export { provenance };

/** Creates the care relationship evidence for a practitioner, once per active assignment. */
export async function ensureCareAssignment(
  actor: CommandActor,
  entry: {
    organizationId: string;
    patientId: string;
    patientRegistrationId: string;
    visitId?: string;
    practitionerId: string;
    userId: string;
    roleCode: 'ATTENDING' | 'CONSULTING' | 'NURSING' | 'ALLIED';
  },
  session: ClientSession,
) {
  const existing = await CareTeamAssignment.findOne({
    organizationId: entry.organizationId,
    patientId: entry.patientId,
    userId: entry.userId,
    status: 'ACTIVE',
  }).session(session);
  if (existing) return existing;
  const [row] = await CareTeamAssignment.create(
    [{ ...stamp(actor.userId), ...entry, periodStart: new Date() }],
    { session },
  );
  await recordChange(
    actor,
    {
      organizationId: entry.organizationId,
      patientId: entry.patientId,
      action: 'CareTeamAssigned',
      resourceType: 'careTeamAssignment',
      resourceId: String(row!._id),
      version: 0,
      reason: entry.roleCode,
    },
    session,
  );
  return row!;
}

/**
 * Starts an encounter. Walk-ins need no appointment. Starting care creates the attending
 * practitioner's care-team assignment, which is the evidence later reads rely on.
 */
export async function startEncounter(
  actor: CommandActor,
  organizationId: string,
  input: z.infer<typeof encounterInput>,
  key: string,
) {
  await authorizeClinical(actor, organizationId, input.patientId, 'clinical.write', {
    facilityId: input.facilityId,
    requireCare: false,
  });
  return command(actor, organizationId, 'encounter.start', key, input, async (session) => {
    const { registration, practitioner } = await authorizeClinical(
      actor,
      organizationId,
      input.patientId,
      'clinical.write',
      { session, facilityId: input.facilityId, requireCare: false },
    );
    await lockActiveFacility(organizationId, input.facilityId, session);
    if (input.appointmentId) {
      const appointment = await Appointment.findOne({
        _id: input.appointmentId,
        organizationId,
        patientId: input.patientId,
        facilityId: input.facilityId,
        status: { $in: ['CHECKED_IN', 'IN_PROGRESS'] },
      }).session(session);
      if (!appointment) throw ApiError.notFound('A checked-in appointment is required');
    }
    if (input.mode !== 'IN_PERSON') {
      const now = new Date();
      const consent = await Consent.findOne({
        _id: input.telemedicineConsentId,
        patientId: input.patientId,
        kind: 'TELEMEDICINE',
        organizationId,
        status: 'ACTIVE',
        $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: now } }],
      }).session(session);
      if (!consent)
        throw new ApiError(
          409,
          'Current telemedicine consent is required',
          undefined,
          'CONSENT_REQUIRED',
        );
    }
    let visitId = input.visitId;
    if (visitId) {
      const visit = await Visit.findOne({
        _id: visitId,
        organizationId,
        patientId: input.patientId,
        status: 'OPEN',
      }).session(session);
      if (!visit) throw ApiError.notFound('Open visit is unavailable');
    } else {
      const [visit] = await Visit.create(
        [
          {
            ...stamp(actor.userId),
            organizationId,
            patientId: input.patientId,
            patientRegistrationId: registration._id,
            facilityId: input.facilityId,
            type: input.visitType ?? (input.mode === 'IN_PERSON' ? 'OUTPATIENT' : 'TELEHEALTH'),
            appointmentId: input.appointmentId,
            startedAt: new Date(),
          },
        ],
        { session },
      );
      visitId = String(visit!._id);
      await recordChange(
        actor,
        {
          organizationId,
          patientId: input.patientId,
          action: 'VisitOpened',
          resourceType: 'visit',
          resourceId: visitId,
          version: 0,
        },
        session,
      );
    }
    const [encounter] = await Encounter.create(
      [
        {
          ...stamp(actor.userId),
          organizationId,
          patientId: input.patientId,
          patientRegistrationId: registration._id,
          visitId,
          appointmentId: input.appointmentId,
          facilityId: input.facilityId,
          type: input.type,
          mode: input.mode,
          telemedicineConsentId: input.telemedicineConsentId,
          responsiblePractitionerId: practitioner._id,
          startedAt: new Date(),
          chiefComplaint: input.chiefComplaint,
        },
      ],
      { session },
    );
    await ensureCareAssignment(
      actor,
      {
        organizationId,
        patientId: input.patientId,
        patientRegistrationId: String(registration._id),
        visitId,
        practitionerId: String(practitioner._id),
        userId: actor.userId,
        roleCode: 'ATTENDING',
      },
      session,
    );
    await recordChange(
      actor,
      {
        organizationId,
        patientId: input.patientId,
        action: 'EncounterStarted',
        resourceType: 'encounter',
        resourceId: String(encounter!._id),
        version: 0,
      },
      session,
    );
    return { id: String(encounter!._id), version: 0 };
  });
}

export async function encounterForWrite(
  actor: CommandActor,
  organizationId: string,
  encounterId: string,
  session: ClientSession,
  permission:
    | 'clinical.write'
    | 'clinical.sign'
    | 'prescriptions.write'
    | 'diagnostics.order' = 'clinical.write',
) {
  const encounter = await Encounter.findOne({ _id: encounterId, organizationId }).session(session);
  if (!encounter) throw ApiError.notFound('Encounter is unavailable');
  const access = await authorizeClinical(
    actor,
    organizationId,
    String(encounter.patientId),
    permission,
    { session, facilityId: String(encounter.facilityId) },
  );
  if (['CANCELLED', 'ENTERED_IN_ERROR'].includes(encounter.status))
    conflict('This encounter no longer accepts documentation');
  return { encounter, ...access };
}

export async function finishEncounter(
  actor: CommandActor,
  organizationId: string,
  encounterId: string,
  expectedVersion: number,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `encounter.finish:${encounterId}`,
    key,
    { expectedVersion },
    async (session) => {
      const { encounter } = await encounterForWrite(actor, organizationId, encounterId, session);
      if (encounter.version !== expectedVersion || encounter.status !== 'IN_PROGRESS') conflict();
      encounter.status = 'FINISHED';
      encounter.endedAt = new Date();
      if (encounter.documentationStatus === 'INCOMPLETE') encounter.documentationStatus = 'READY';
      encounter.updatedBy = { kind: 'USER', id: actor.userId };
      await encounter.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          patientId: String(encounter.patientId),
          action: 'EncounterFinished',
          resourceType: 'encounter',
          resourceId: encounterId,
          version: encounter.version,
        },
        session,
      );
      return { id: encounterId, version: encounter.version };
    },
  );
}

export async function closeVisit(
  actor: CommandActor,
  organizationId: string,
  visitId: string,
  expectedVersion: number,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `visit.close:${visitId}`,
    key,
    { expectedVersion },
    async (session) => {
      const visit = await Visit.findOne({
        _id: visitId,
        organizationId,
        version: expectedVersion,
        status: 'OPEN',
      }).session(session);
      if (!visit) conflict();
      await authorizeClinical(actor, organizationId, String(visit.patientId), 'clinical.write', {
        session,
        facilityId: String(visit.facilityId),
      });
      if (
        await Encounter.exists({ visitId, status: { $in: ['PLANNED', 'IN_PROGRESS'] } }).session(
          session,
        )
      )
        conflict('Finish open encounters first');
      if (visit.type === 'INPATIENT') conflict('Inpatient visits close through discharge');
      visit.status = 'CLOSED';
      visit.endedAt = new Date();
      visit.updatedBy = { kind: 'USER', id: actor.userId };
      await visit.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          patientId: String(visit.patientId),
          action: 'VisitClosed',
          resourceType: 'visit',
          resourceId: visitId,
          version: visit.version,
        },
        session,
      );
      return { id: visitId, version: visit.version };
    },
  );
}

const presentEncounter = (row: ReturnType<typeof Encounter.hydrate>) => ({
  id: String(row._id),
  patientId: String(row.patientId),
  visitId: String(row.visitId),
  appointmentId: row.appointmentId ? String(row.appointmentId) : undefined,
  facilityId: String(row.facilityId),
  type: row.type,
  mode: row.mode,
  responsiblePractitionerId: String(row.responsiblePractitionerId),
  status: row.status,
  startedAt: row.startedAt,
  endedAt: row.endedAt,
  chiefComplaint: row.chiefComplaint,
  documentationStatus: row.documentationStatus,
  version: row.version,
});

export async function getEncounter(
  actor: CommandActor,
  organizationId: string,
  encounterId: string,
) {
  const encounter = await Encounter.findOne({ _id: encounterId, organizationId });
  if (!encounter) throw ApiError.notFound();
  await authorizeClinical(actor, organizationId, String(encounter.patientId), 'clinical.read', {
    facilityId: String(encounter.facilityId),
  });
  await recordRead(actor, 'encounter', encounterId, organizationId, String(encounter.patientId));
  return presentEncounter(encounter);
}

export async function listEncounters(
  actor: CommandActor,
  organizationId: string,
  query: z.infer<typeof encounterQuery>,
) {
  if (!query.patientId) throw ApiError.badRequest('Choose a patient');
  await authorizeClinical(actor, organizationId, query.patientId, 'clinical.read');
  const rows = await Encounter.find({
    organizationId,
    patientId: query.patientId,
    ...before(query.before),
  })
    .sort({ _id: -1 })
    .limit(query.limit + 1);
  await recordRead(actor, 'encounter.list', query.patientId, organizationId, query.patientId);
  return pageOf(rows, query.limit, presentEncounter);
}

/** Adds another member of the provider to the patient's care team (e.g. the ward nurse). */
export async function assignCareTeam(
  actor: CommandActor,
  organizationId: string,
  patientId: string,
  input: z.infer<typeof careTeamInput>,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `care-team.assign:${patientId}`,
    key,
    input,
    async (session) => {
      const { registration } = await authorizeClinical(
        actor,
        organizationId,
        patientId,
        'clinical.write',
        { session },
      );
      const membership = await Membership.findOne({
        organizationId,
        userId: input.userId,
        status: 'ACTIVE',
      }).session(session);
      if (!membership) throw ApiError.notFound('The colleague is not an active member');
      const practitioner = await Practitioner.findOne({
        userId: input.userId,
        status: 'ACTIVE',
      }).session(session);
      if (!practitioner)
        throw ApiError.notFound('The colleague has no active professional profile');
      const row = await ensureCareAssignment(
        actor,
        {
          organizationId,
          patientId,
          patientRegistrationId: String(registration._id),
          visitId: input.visitId,
          practitionerId: String(practitioner._id),
          userId: input.userId,
          roleCode: input.roleCode,
        },
        session,
      );
      return { id: String(row._id), version: row.version };
    },
  );
}

export async function endCareTeam(
  actor: CommandActor,
  organizationId: string,
  assignmentId: string,
  input: z.infer<typeof endCareInput>,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `care-team.end:${assignmentId}`,
    key,
    input,
    async (session) => {
      const assignment = await CareTeamAssignment.findOne({
        _id: assignmentId,
        organizationId,
        version: input.expectedVersion,
        status: 'ACTIVE',
      }).session(session);
      if (!assignment) conflict();
      if (String(assignment.userId) === actor.userId)
        await scoped(actor, organizationId, 'clinical.read', session);
      else
        await authorizeClinical(
          actor,
          organizationId,
          String(assignment.patientId),
          'clinical.write',
          { session },
        );
      assignment.status = 'ENDED';
      assignment.periodEnd = new Date();
      assignment.updatedBy = { kind: 'USER', id: actor.userId };
      await assignment.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          patientId: String(assignment.patientId),
          action: 'CareTeamEnded',
          resourceType: 'careTeamAssignment',
          resourceId: assignmentId,
          version: assignment.version,
          reason: input.reason,
        },
        session,
      );
      return { id: assignmentId, version: assignment.version };
    },
  );
}
