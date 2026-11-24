import { randomUUID } from 'node:crypto';
import type { ClientSession, InferSchemaType, Types } from 'mongoose';
import type { z } from 'zod';
import type { CommandActor } from '../../shared/domain/healthcare.js';
import { command, transaction, conflict } from '../../shared/application/command.js';
import {
  actorRef,
  before,
  facilityFilter,
  formatNumber,
  nextNumber,
  pageOf,
  scoped,
  serviceActor,
  type OperationActor,
} from '../../shared/application/scope.js';
import { stamp } from '../../shared/persistence/schema.js';
import { env } from '../../config/env.js';
import { ApiError } from '../../utils/api-error.js';
import { authorizeOrganization } from '../access/access.service.js';
import { authorizePatient, patientDemographics } from '../patients/patient.service.js';
import { Patient, PatientRegistration } from '../patients/patient.model.js';
import { recordChange, recordRead, nextMrn } from '../operations/operation.service.js';
import { eligibleAffiliation } from '../providers/provider.policy.js';
import { reservationPlan } from '../scheduling/scheduling.service.js';
import {
  ensureCalendars,
  lockCalendars,
  assertNoOverlap,
  atIndiaMinute,
} from '../scheduling/calendar.service.js';
import { ResourceClaim } from '../scheduling/scheduling.model.js';
import { settleCancellation } from '../billing/cancellation.service.js';
import { Appointment, AppointmentHistory } from './appointment.model.js';
import { enqueue } from './queue.service.js';
import type {
  holdInput,
  cancelInput,
  appointmentQuery,
  rescheduleInput,
} from './appointment.validation.js';

export type AppointmentDocument = ReturnType<typeof Appointment.hydrate>;
type AppointmentRow = InferSchemaType<typeof Appointment.schema> & { _id: Types.ObjectId };

/** Appends immutable history and the audit/outbox pair. Call once after each saved change. */
async function changed(
  actor: OperationActor,
  row: AppointmentDocument,
  action: string,
  session: ClientSession,
  fromStatus?: string,
  previous?: { startAt: Date; endAt: Date },
) {
  const who = actorRef(actor);
  await AppointmentHistory.create(
    [
      {
        appointmentId: row._id,
        organizationId: row.organizationId,
        sequence: row.version,
        actorId: who.id,
        actorKind: who.kind,
        action,
        fromStatus,
        toStatus: row.status,
        reason: row.reason,
        startAt: row.startAt,
        endAt: row.endAt,
        previousStartAt: previous?.startAt,
        previousEndAt: previous?.endAt,
        requestId: actor.requestId,
      },
    ],
    { session },
  );
  await recordChange(
    actor,
    {
      organizationId: String(row.organizationId),
      patientId: String(row.patientId),
      action,
      resourceType: 'appointment',
      resourceId: String(row._id),
      version: row.version,
      reason: row.reason ?? undefined,
    },
    session,
  );
}

/**
 * Resolves the appointment through either provider scope (organizationId given) or patient
 * authority. A wrong tenant or unauthorized patient is reported as not found.
 */
export async function appointmentScope(
  actor: CommandActor,
  appointmentId: string,
  options: {
    organizationId?: string;
    session?: ClientSession;
    write?: boolean;
    permission?: 'appointments.manage' | 'appointments.read' | 'clinical.write';
  } = {},
) {
  const { session } = options;
  const appointment = await Appointment.findOne({
    _id: appointmentId,
    ...(options.organizationId ? { organizationId: options.organizationId } : {}),
  }).session(session ?? null);
  if (!appointment) throw ApiError.notFound();
  if (options.organizationId) {
    const permission =
      options.permission ?? (options.write ? 'appointments.manage' : 'appointments.read');
    const facilityId = String(appointment.facilityId);
    if (options.write && session)
      await scoped(actor, options.organizationId, permission, session, { facilityId });
    else
      await authorizeOrganization(actor, options.organizationId, permission, {
        facilityId,
        session,
      });
  } else
    await authorizePatient(
      actor,
      String(appointment.patientId),
      'registration.create',
      session,
      options.write,
    );
  return appointment;
}

async function ensureRegistration(
  actor: OperationActor,
  appointment: AppointmentDocument,
  session: ClientSession,
) {
  const existing = await PatientRegistration.findOne({
    organizationId: appointment.organizationId,
    patientId: appointment.patientId,
    status: 'ACTIVE',
  }).session(session);
  if (existing) {
    appointment.registrationId = existing._id;
    return;
  }
  const patient = await Patient.findById(appointment.patientId).session(session);
  if (!patient) throw ApiError.notFound('Patient is unavailable');
  const who = actorRef(actor);
  const [registration] = await PatientRegistration.create(
    [
      {
        organizationId: appointment.organizationId,
        patientId: appointment.patientId,
        primaryFacilityId: appointment.facilityId,
        mrn: await nextMrn(String(appointment.organizationId), session),
        demographicSnapshot: patientDemographics(patient),
        createdBy: who,
        updatedBy: who,
      },
    ],
    { session },
  );
  appointment.registrationId = registration!._id;
  await recordChange(
    actor,
    {
      organizationId: String(appointment.organizationId),
      patientId: String(appointment.patientId),
      action: 'PatientRegisteredFromBooking',
      resourceType: 'patientRegistration',
      resourceId: String(registration!._id),
      version: 0,
    },
    session,
  );
}

/**
 * Reservation protocol: ensure calendar anchors, then in one transaction write every touched
 * resource/day anchor in deterministic order, check overlaps and create token-bound claims.
 */
export async function createHold(
  actor: CommandActor,
  input: z.infer<typeof holdInput>,
  key: string,
  organizationId?: string,
) {
  if (!organizationId) await authorizePatient(actor, input.patientId, 'registration.create');
  else await authorizeOrganization(actor, organizationId, 'appointments.manage');
  const preview = await reservationPlan(input.offeringId, new Date(input.startAt));
  const patientKey = `patient:${input.patientId}`;
  await ensureCalendars(
    [...preview.resourceKeys, patientKey],
    preview.claimStartAt,
    preview.claimEndAt,
  );
  return command(
    actor,
    organizationId ?? 'self',
    'appointment.hold',
    key,
    input,
    async (session) => {
      const plan = await reservationPlan(input.offeringId, new Date(input.startAt), session, true);
      if (
        plan.offering.version !== input.offeringVersion ||
        String(plan.price._id) !== input.priceId
      )
        throw new ApiError(
          409,
          'Price or service changed; accept a fresh quote',
          undefined,
          'QUOTE_CHANGED',
        );
      if (organizationId) {
        if (String(plan.offering.organizationId) !== organizationId) throw ApiError.notFound();
        await scoped(actor, organizationId, 'appointments.manage', session, {
          facilityId: String(plan.facility._id),
        });
        const registered = await PatientRegistration.exists({
          organizationId,
          patientId: input.patientId,
          status: 'ACTIVE',
        }).session(session);
        if (!registered) throw ApiError.notFound('Register the patient before staff booking');
      } else await authorizePatient(actor, input.patientId, 'registration.create', session, true);
      const keys = [...plan.resourceKeys, patientKey];
      await lockCalendars(keys, plan.claimStartAt, plan.claimEndAt, session);
      await assertNoOverlap(keys, plan.claimStartAt, plan.claimEndAt, session);
      const holdMinutes = plan.offering.paymentPolicy === 'PREPAY' ? env.PAYMENT_HOLD_MINUTES : 10;
      const holdToken = randomUUID();
      const holdExpiresAt = new Date(
        Math.min(Date.now() + holdMinutes * 60_000, plan.startAt.getTime()),
      );
      const bookingNumber = formatNumber(
        'APT',
        await nextNumber(plan.organization._id, 'APPOINTMENT', session),
      );
      const [appointment] = await Appointment.create(
        [
          {
            ...stamp(actor.userId),
            organizationId: plan.organization._id,
            facilityId: plan.facility._id,
            patientId: input.patientId,
            bookedBy: actor.userId,
            bookingNumber,
            source: organizationId ? 'PROVIDER' : 'MARKETPLACE',
            doctorId: plan.doctor._id,
            practitionerId: plan.practitioner._id,
            doctorAffiliationId: plan.affiliation._id,
            offeringId: plan.offering._id,
            offeringVersion: plan.offering.version,
            scheduleRuleId: plan.rule._id,
            startAt: plan.startAt,
            endAt: plan.endAt,
            claimStartAt: plan.claimStartAt,
            claimEndAt: plan.claimEndAt,
            resourceKeys: keys,
            holdToken,
            holdExpiresAt,
            reasonForVisit: input.reasonForVisit,
            offeringSnapshot: {
              name: plan.offering.name,
              mode: plan.offering.mode,
              durationMinutes: plan.offering.durationMinutes,
            },
            priceSnapshot: {
              priceId: plan.price._id,
              amountMinor: plan.price.amountMinor,
              taxBasisPoints: plan.price.taxBasisPoints,
              taxMinor: plan.price.taxMinor,
              totalMinor: plan.price.totalMinor,
              currency: plan.price.currency,
            },
            paymentPolicy: plan.offering.paymentPolicy,
            cancellationPolicy: plan.offering.cancellationPolicy,
          },
        ],
        { session },
      );
      await ResourceClaim.create(
        keys.map((resourceKey) => ({
          organizationId: plan.organization._id,
          resourceKey,
          appointmentId: appointment!._id,
          token: holdToken,
          startAt: plan.claimStartAt,
          endAt: plan.claimEndAt,
          expiresAt: holdExpiresAt,
          state: 'HELD' as const,
        })),
        { session, ordered: true },
      );
      await changed(actor, appointment!, 'AppointmentHeld', session);
      return { id: String(appointment!._id), version: 0 };
    },
  );
}

/**
 * Confirms a still-valid hold. Payment capture processing calls this inside its own ledger
 * transaction; a false result means the capture must become a refund obligation.
 */
export async function confirmHeldAppointment(
  actor: OperationActor,
  appointment: AppointmentDocument,
  session: ClientSession,
  holdToken: string,
): Promise<boolean> {
  if (appointment.status === 'CONFIRMED' && appointment.holdToken === holdToken) return true;
  const now = new Date();
  if (
    appointment.status !== 'HELD' ||
    appointment.holdToken !== holdToken ||
    appointment.holdExpiresAt <= now ||
    appointment.startAt <= now ||
    appointment.requiresReassignment
  )
    return false;
  await lockCalendars(
    appointment.resourceKeys,
    appointment.claimStartAt,
    appointment.claimEndAt,
    session,
  );
  try {
    await eligibleAffiliation(String(appointment.doctorAffiliationId), session, { lock: true });
    await assertNoOverlap(
      appointment.resourceKeys,
      appointment.claimStartAt,
      appointment.claimEndAt,
      session,
      String(appointment._id),
    );
  } catch (error) {
    if (error instanceof ApiError && [400, 403, 404, 409].includes(error.statusCode)) return false;
    throw error;
  }
  const owned = await ResourceClaim.countDocuments({
    appointmentId: appointment._id,
    token: holdToken,
    state: 'HELD',
    expiresAt: { $gt: now },
  }).session(session);
  if (owned !== appointment.resourceKeys.length) return false;
  await ensureRegistration(actor, appointment, session);
  appointment.status = 'CONFIRMED';
  appointment.confirmedAt = now;
  appointment.updatedBy = actorRef(actor);
  await appointment.save({ session });
  await ResourceClaim.updateMany(
    { appointmentId: appointment._id, token: holdToken, state: 'HELD' },
    { $set: { state: 'CONFIRMED' }, $unset: { expiresAt: 1 } },
    { session },
  );
  await changed(actor, appointment, 'AppointmentConfirmed', session, 'HELD');
  return true;
}

export async function confirmAppointment(
  actor: CommandActor,
  appointmentId: string,
  expectedVersion: number,
  key: string,
  organizationId?: string,
) {
  await appointmentScope(actor, appointmentId, { organizationId, write: true });
  const operation = `appointment.confirm:${appointmentId}`;
  return command(
    actor,
    organizationId ?? 'self',
    operation,
    key,
    { expectedVersion },
    async (session) => {
      const appointment = await appointmentScope(actor, appointmentId, {
        organizationId,
        write: true,
        session,
      });
      if (appointment.version !== expectedVersion) conflict();
      if (appointment.paymentPolicy === 'PREPAY')
        throw new ApiError(
          409,
          'Prepaid appointments are confirmed only by a verified payment capture',
          undefined,
          'PAYMENT_NOT_READY',
        );
      if (!(await confirmHeldAppointment(actor, appointment, session, appointment.holdToken)))
        throw new ApiError(
          409,
          'The hold expired or the provider/time is no longer eligible',
          undefined,
          'HOLD_EXPIRED',
        );
      return { id: appointmentId, version: appointment.version };
    },
  );
}

async function releaseClaims(appointment: AppointmentDocument, session: ClientSession) {
  await lockCalendars(
    appointment.resourceKeys,
    appointment.claimStartAt,
    appointment.claimEndAt,
    session,
  );
  await ResourceClaim.updateMany(
    { appointmentId: appointment._id, token: appointment.holdToken, state: { $ne: 'RELEASED' } },
    { $set: { state: 'RELEASED' } },
    { session },
  );
}

/** Cancellation releases resources and computes the refund obligation from the policy snapshot. */
export async function cancelAppointment(
  actor: CommandActor,
  appointmentId: string,
  input: z.infer<typeof cancelInput>,
  key: string,
  organizationId?: string,
) {
  await appointmentScope(actor, appointmentId, { organizationId, write: true });
  const operation = `appointment.cancel:${appointmentId}`;
  return command(actor, organizationId ?? 'self', operation, key, input, async (session) => {
    const appointment = await appointmentScope(actor, appointmentId, {
      organizationId,
      session,
      write: true,
    });
    if (
      appointment.version !== input.expectedVersion ||
      !['HELD', 'CONFIRMED', 'CHECKED_IN'].includes(appointment.status)
    )
      conflict('Appointment cannot be cancelled in its current state');
    const from = appointment.status;
    await releaseClaims(appointment, session);
    appointment.status = 'CANCELLED';
    appointment.cancelledAt = new Date();
    appointment.reason = input.reason;
    appointment.updatedBy = { kind: 'USER', id: actor.userId };
    await appointment.save({ session });
    await changed(
      actor,
      appointment,
      organizationId ? 'AppointmentCancelledByProvider' : 'AppointmentCancelledByPatient',
      session,
      from,
    );
    // Provider cancellations refund in full; patient cancellations follow the accepted policy.
    await settleCancellation(actor, appointment, session, organizationId ? 'PROVIDER' : 'PATIENT');
    return { id: appointmentId, version: appointment.version };
  });
}

/** Reserves the new interval and releases the old one atomically; the booking identity is kept. */
export async function rescheduleAppointment(
  actor: CommandActor,
  appointmentId: string,
  input: z.infer<typeof rescheduleInput>,
  key: string,
  organizationId?: string,
) {
  const original = await appointmentScope(actor, appointmentId, { organizationId, write: true });
  const preview = await reservationPlan(input.offeringId, new Date(input.startAt));
  await ensureCalendars(
    [...preview.resourceKeys, `patient:${original.patientId}`],
    preview.claimStartAt,
    preview.claimEndAt,
  );
  const operation = `appointment.reschedule:${appointmentId}`;
  return command(actor, organizationId ?? 'self', operation, key, input, async (session) => {
    const appointment = await appointmentScope(actor, appointmentId, {
      organizationId,
      write: true,
      session,
    });
    if (
      appointment.version !== input.expectedVersion ||
      !['HELD', 'CONFIRMED'].includes(appointment.status)
    )
      conflict('Only current held or confirmed appointments may be rescheduled');
    if (
      appointment.status === 'HELD' &&
      (appointment.holdExpiresAt <= new Date() || appointment.paymentPolicy === 'PREPAY')
    )
      conflict('Expired or prepaid holds must be cancelled and booked again');
    const plan = await reservationPlan(input.offeringId, new Date(input.startAt), session, true);
    if (
      String(plan.organization._id) !== String(appointment.organizationId) ||
      String(plan.facility._id) !== String(appointment.facilityId)
    )
      throw ApiError.badRequest('Changing provider or facility requires a new booking');
    if (plan.offering.version !== input.offeringVersion || String(plan.price._id) !== input.priceId)
      throw new ApiError(409, 'Accept a fresh quote', undefined, 'QUOTE_CHANGED');
    if (
      plan.price.totalMinor !== appointment.priceSnapshot.totalMinor ||
      plan.offering.paymentPolicy !== appointment.paymentPolicy
    )
      throw ApiError.badRequest('Price changes require cancellation and a new booking');
    const keys = [...plan.resourceKeys, `patient:${appointment.patientId}`];
    // One deterministic lock order across the old and new intervals prevents crossing reschedules.
    const intervals = [
      {
        keys: appointment.resourceKeys,
        start: appointment.claimStartAt,
        end: appointment.claimEndAt,
      },
      { keys, start: plan.claimStartAt, end: plan.claimEndAt },
    ].sort((a, b) => a.start.getTime() - b.start.getTime());
    for (const interval of intervals)
      await lockCalendars(interval.keys, interval.start, interval.end, session);
    await assertNoOverlap(keys, plan.claimStartAt, plan.claimEndAt, session, appointmentId);
    const previous = { startAt: appointment.startAt, endAt: appointment.endAt };
    await ResourceClaim.updateMany(
      { appointmentId, token: appointment.holdToken },
      { $set: { state: 'RELEASED' } },
      { session },
    );
    appointment.set({
      offeringId: plan.offering._id,
      offeringVersion: plan.offering.version,
      scheduleRuleId: plan.rule._id,
      doctorAffiliationId: plan.affiliation._id,
      doctorId: plan.doctor._id,
      practitionerId: plan.practitioner._id,
      startAt: plan.startAt,
      endAt: plan.endAt,
      claimStartAt: plan.claimStartAt,
      claimEndAt: plan.claimEndAt,
      resourceKeys: keys,
      holdToken: randomUUID(),
      requiresReassignment: false,
      offeringSnapshot: {
        name: plan.offering.name,
        mode: plan.offering.mode,
        durationMinutes: plan.offering.durationMinutes,
      },
      reason: input.reason,
    });
    appointment.updatedBy = { kind: 'USER', id: actor.userId };
    await appointment.save({ session });
    const held = appointment.status === 'HELD';
    await ResourceClaim.create(
      keys.map((resourceKey) => ({
        organizationId: appointment.organizationId,
        resourceKey,
        appointmentId,
        token: appointment.holdToken,
        startAt: plan.claimStartAt,
        endAt: plan.claimEndAt,
        state: held ? ('HELD' as const) : ('CONFIRMED' as const),
        expiresAt: held ? appointment.holdExpiresAt : undefined,
      })),
      { session, ordered: true },
    );
    await changed(
      actor,
      appointment,
      'AppointmentRescheduled',
      session,
      appointment.status,
      previous,
    );
    return { id: appointmentId, version: appointment.version };
  });
}

const TRANSITIONS = {
  'check-in': ['CONFIRMED', 'CHECKED_IN'],
  'no-show': ['CONFIRMED', 'NO_SHOW'],
  start: ['CHECKED_IN', 'IN_PROGRESS'],
  complete: ['IN_PROGRESS', 'COMPLETED'],
  discontinue: ['IN_PROGRESS', 'DISCONTINUED'],
} as const;
export type AppointmentAction = keyof typeof TRANSITIONS;

/** Explicit commands per transition; there is no generic status patch. */
export async function transitionAppointment(
  actor: CommandActor,
  organizationId: string,
  appointmentId: string,
  action: AppointmentAction,
  expectedVersion: number,
  reason: string | undefined,
  key: string,
) {
  // Front-desk transitions need booking authority; conducting care needs clinical authority
  // and, below, being the assigned verified doctor.
  const permission =
    action === 'check-in' || action === 'no-show' ? 'appointments.manage' : 'clinical.write';
  await appointmentScope(actor, appointmentId, { organizationId, write: true, permission });
  if (action === 'discontinue' && !reason)
    throw ApiError.badRequest('A discontinuation reason is required');
  const operation = `appointment.${action}:${appointmentId}`;
  return command(
    actor,
    organizationId,
    operation,
    key,
    { expectedVersion, reason },
    async (session) => {
      const appointment = await appointmentScope(actor, appointmentId, {
        organizationId,
        write: true,
        session,
        permission,
      });
      const [from, to] = TRANSITIONS[action];
      if (appointment.version !== expectedVersion || appointment.status !== from) conflict();
      const now = new Date();
      if (action === 'no-show' && now < appointment.endAt)
        throw ApiError.badRequest('A no-show can be recorded only after the appointment ends');
      if (action === 'check-in' && now.getTime() < appointment.startAt.getTime() - 2 * 3600_000)
        throw ApiError.badRequest('Check-in opens two hours before the appointment');
      if (action === 'start' || action === 'complete' || action === 'discontinue') {
        const eligibility = await eligibleAffiliation(
          String(appointment.doctorAffiliationId),
          session,
          {
            published: false,
            lock: true,
          },
        );
        if (String(eligibility.practitioner.userId) !== actor.userId)
          throw ApiError.forbidden(
            'Only the assigned verified doctor may conduct this appointment',
          );
        if (appointment.requiresReassignment) conflict('This appointment requires reassignment');
      }
      appointment.status = to;
      appointment.reason = reason;
      appointment.updatedBy = { kind: 'USER', id: actor.userId };
      if (action === 'check-in') appointment.checkedInAt = now;
      if (action === 'start') appointment.startedAt = now;
      if (action === 'complete' || action === 'discontinue') appointment.completedAt = now;
      if (action === 'check-in') await ensureRegistration(actor, appointment, session);
      if (action === 'complete' || action === 'discontinue' || action === 'no-show')
        await releaseClaims(appointment, session);
      await appointment.save({ session });
      await changed(actor, appointment, `Appointment.${action}`, session, from);
      if (action === 'check-in')
        await enqueue(
          actor,
          {
            organizationId,
            facilityId: String(appointment.facilityId),
            patientId: String(appointment.patientId),
            patientRegistrationId: String(appointment.registrationId),
            appointmentId,
          },
          session,
        );
      return { id: appointmentId, version: appointment.version };
    },
  );
}

function present(appointment: AppointmentRow) {
  return {
    id: String(appointment._id),
    bookingNumber: appointment.bookingNumber,
    organizationId: String(appointment.organizationId),
    facilityId: String(appointment.facilityId),
    patientId: String(appointment.patientId),
    doctorId: String(appointment.doctorId),
    registrationId: appointment.registrationId ? String(appointment.registrationId) : undefined,
    offeringId: String(appointment.offeringId),
    startAt: appointment.startAt,
    endAt: appointment.endAt,
    status: appointment.status,
    holdExpiresAt: appointment.status === 'HELD' ? appointment.holdExpiresAt : undefined,
    offering: appointment.offeringSnapshot,
    price: appointment.priceSnapshot,
    paymentPolicy: appointment.paymentPolicy,
    cancellationPolicy: appointment.cancellationPolicy,
    reasonForVisit: appointment.reasonForVisit,
    requiresReassignment: appointment.requiresReassignment,
    refundRequired: appointment.refundRequired,
    reason: appointment.reason,
    version: appointment.version,
  };
}

export async function getAppointment(
  actor: CommandActor,
  appointmentId: string,
  organizationId?: string,
) {
  const appointment = await appointmentScope(actor, appointmentId, { organizationId });
  await recordRead(
    actor,
    'appointment',
    appointmentId,
    String(appointment.organizationId),
    String(appointment.patientId),
  );
  return present(appointment.toObject() as AppointmentRow);
}

export async function listAppointments(
  actor: CommandActor,
  query: z.infer<typeof appointmentQuery>,
  organizationId?: string,
) {
  let scopeFilter = {};
  if (organizationId) {
    const { membership } = await authorizeOrganization(actor, organizationId, 'appointments.read', {
      facilityId: query.facilityId,
    });
    scopeFilter = { organizationId, ...facilityFilter(membership) };
  } else {
    if (!query.patientId) throw ApiError.badRequest('Choose a patient profile');
    await authorizePatient(actor, query.patientId, 'registration.create');
  }
  const rows = await Appointment.find({
    ...scopeFilter,
    ...(query.facilityId ? { facilityId: query.facilityId } : {}),
    ...(query.patientId ? { patientId: query.patientId } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.date
      ? { startAt: { $gte: atIndiaMinute(query.date, 0), $lt: atIndiaMinute(query.date, 1440) } }
      : {}),
    ...(query.requiresReassignment
      ? { requiresReassignment: query.requiresReassignment === 'true' }
      : {}),
    ...before(query.before),
  })
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean();
  for (const row of rows.slice(0, query.limit))
    await recordRead(
      actor,
      'appointment',
      String(row._id),
      String(row.organizationId),
      String(row.patientId),
    );
  return pageOf(rows as AppointmentRow[], query.limit, present);
}

/** Sweeper: expires only the exact token/state it observed. Commands never rely on it running. */
export async function expireAppointmentHolds(limit = 100): Promise<number> {
  const candidates = await Appointment.find({ status: 'HELD', holdExpiresAt: { $lte: new Date() } })
    .select({ _id: 1, holdToken: 1 })
    .limit(limit)
    .lean();
  let expired = 0;
  for (const candidate of candidates)
    await transaction(async (session) => {
      const appointment = await Appointment.findOne({
        _id: candidate._id,
        holdToken: candidate.holdToken,
        status: 'HELD',
        holdExpiresAt: { $lte: new Date() },
      }).session(session);
      if (!appointment) return;
      await releaseClaims(appointment, session);
      appointment.status = 'EXPIRED';
      appointment.updatedBy = { kind: 'SERVICE', id: 'hold-expiry' };
      await appointment.save({ session });
      await changed(
        serviceActor('hold-expiry', randomUUID()),
        appointment,
        'AppointmentHoldExpired',
        session,
        'HELD',
      );
      expired += 1;
    });
  return expired;
}
