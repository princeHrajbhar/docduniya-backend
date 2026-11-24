import { Types, type ClientSession } from 'mongoose';
import type { z } from 'zod';
import type { CommandActor, Pagination } from '../../shared/domain/healthcare.js';
import { command, conflict } from '../../shared/application/command.js';
import { stamp } from '../../shared/persistence/schema.js';
import { ApiError } from '../../utils/api-error.js';
import { taxMinor } from '../../shared/domain/money.js';
import { authorizeOrganization, lockMembership } from '../access/access.service.js';
import { lockActiveFacility } from '../organizations/organization.repository.js';
import { recordChange } from '../operations/operation.service.js';
import { eligibleAffiliation, ownDoctor } from '../providers/provider.policy.js';
import { Appointment } from '../appointments/appointment.model.js';
import {
  ServiceOffering,
  Price,
  FacilityResource,
  ScheduleRule,
  ScheduleException,
  ResourceClaim,
} from './scheduling.model.js';
import {
  activeClaimFilter,
  atIndiaMinute,
  ensureCalendars,
  indiaClock,
  lockCalendars,
} from './calendar.service.js';
import type {
  resourceInput,
  offeringInput,
  priceInput,
  offeringStateInput,
  scheduleInput,
  blockInput,
  offeringQuery,
} from './scheduling.validation.js';

export async function createResource(
  actor: CommandActor,
  organizationId: string,
  input: z.infer<typeof resourceInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'services.manage', {
    facilityId: input.facilityId,
  });
  return command(actor, organizationId, 'resource.create', key, input, async (session) => {
    const { membership } = await authorizeOrganization(actor, organizationId, 'services.manage', {
      facilityId: input.facilityId,
      session,
    });
    await lockMembership(membership._id, session);
    await lockActiveFacility(organizationId, input.facilityId, session);
    const [resource] = await FacilityResource.create(
      [{ ...stamp(actor.userId), organizationId, ...input }],
      { session },
    );
    const id = String(resource!._id);
    await recordChange(
      actor,
      {
        organizationId,
        action: 'ResourceCreated',
        resourceType: 'resource',
        resourceId: id,
        version: 0,
      },
      session,
    );
    return { id, version: 0 };
  });
}
export async function createOffering(
  actor: CommandActor,
  organizationId: string,
  input: z.infer<typeof offeringInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'services.manage');
  return command(actor, organizationId, 'offering.create', key, input, async (session) => {
    const eligibility = await eligibleAffiliation(input.doctorAffiliationId, session, {
      published: false,
      lock: true,
    });
    if (String(eligibility.organization._id) !== organizationId) throw ApiError.notFound();
    const facilityId = String(eligibility.facility._id);
    const { membership } = await authorizeOrganization(actor, organizationId, 'services.manage', {
      facilityId,
      session,
    });
    await lockMembership(membership._id, session);
    const count = await FacilityResource.countDocuments({
      _id: { $in: input.resourceIds },
      organizationId,
      facilityId,
      status: 'ACTIVE',
    }).session(session);
    if (count !== input.resourceIds.length)
      throw ApiError.notFound('A resource is outside the facility or inactive');
    const [offering] = await ServiceOffering.create(
      [{ ...stamp(actor.userId), ...input, organizationId, facilityId }],
      { session },
    );
    const id = String(offering!._id);
    await recordChange(
      actor,
      {
        organizationId,
        action: 'ServiceOfferingCreated',
        resourceType: 'serviceOffering',
        resourceId: id,
        version: 0,
      },
      session,
    );
    return { id, version: 0 };
  });
}
export async function publishPrice(
  actor: CommandActor,
  organizationId: string,
  offeringId: string,
  input: z.infer<typeof priceInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'services.manage');
  return command(
    actor,
    organizationId,
    `price.publish:${offeringId}`,
    key,
    input,
    async (session) => {
      const offering = await ServiceOffering.findOne({
        _id: offeringId,
        organizationId,
        version: input.expectedVersion,
      }).session(session);
      if (!offering) conflict();
      const { membership } = await authorizeOrganization(actor, organizationId, 'services.manage', {
        facilityId: String(offering.facilityId),
        session,
      });
      await lockMembership(membership._id, session);
      if (offering.paymentPolicy === 'FREE' && input.amountMinor !== 0)
        throw ApiError.badRequest('Free services must have a zero price');
      const tax = taxMinor(input.amountMinor, input.taxBasisPoints);
      const [price] = await Price.create(
        [
          {
            ...stamp(actor.userId),
            organizationId,
            offeringId,
            amountMinor: input.amountMinor,
            taxBasisPoints: input.taxBasisPoints,
            taxMinor: tax,
            totalMinor: input.amountMinor + tax,
            currency: input.currency,
          },
        ],
        { session },
      );
      offering.currentPriceId = price!._id;
      offering.updatedBy = { kind: 'USER', id: actor.userId };
      await offering.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          action: 'PricePublished',
          resourceType: 'price',
          resourceId: String(price!._id),
          version: 0,
        },
        session,
      );
      return { id: offeringId, version: offering.version };
    },
  );
}
export async function changeOfferingState(
  actor: CommandActor,
  organizationId: string,
  offeringId: string,
  input: z.infer<typeof offeringStateInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'services.manage');
  return command(
    actor,
    organizationId,
    `offering.state:${offeringId}`,
    key,
    input,
    async (session) => {
      const offering = await ServiceOffering.findOne({
        _id: offeringId,
        organizationId,
        version: input.expectedVersion,
      }).session(session);
      if (!offering) conflict();
      const { membership } = await authorizeOrganization(actor, organizationId, 'services.manage', {
        facilityId: String(offering.facilityId),
        session,
      });
      await lockMembership(membership._id, session);
      if (input.status === 'ACTIVE') {
        await eligibleAffiliation(String(offering.doctorAffiliationId), session, {
          published: false,
          lock: true,
        });
        if (!offering.currentPriceId)
          throw ApiError.badRequest('Publish a price before activating the service');
      }
      offering.status = input.status;
      offering.updatedBy = { kind: 'USER', id: actor.userId };
      await offering.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          action: 'ServiceOfferingStateChanged',
          resourceType: 'serviceOffering',
          resourceId: offeringId,
          version: offering.version,
          reason: input.reason,
        },
        session,
      );
      return { id: offeringId, version: offering.version };
    },
  );
}
export async function createSchedule(
  actor: CommandActor,
  organizationId: string,
  input: z.infer<typeof scheduleInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'scheduling.manage');
  return command(actor, organizationId, 'schedule.create', key, input, async (session) => {
    const offering = await ServiceOffering.findOne({
      _id: input.offeringId,
      organizationId,
    }).session(session);
    if (!offering) throw ApiError.notFound();
    const { membership } = await authorizeOrganization(actor, organizationId, 'scheduling.manage', {
      facilityId: String(offering.facilityId),
      session,
    });
    await lockMembership(membership._id, session);
    if (input.endMinute - input.startMinute < offering.durationMinutes)
      throw ApiError.badRequest('Schedule window is shorter than the consultation');
    if (
      new Date(input.effectiveUntil).getTime() - new Date(input.effectiveFrom).getTime() >
      366 * 86400_000
    )
      throw ApiError.badRequest('Schedule windows are limited to one year');
    const [schedule] = await ScheduleRule.create(
      [{ ...stamp(actor.userId), organizationId, facilityId: offering.facilityId, ...input }],
      { session },
    );
    const id = String(schedule!._id);
    await recordChange(
      actor,
      {
        organizationId,
        action: 'ScheduleCreated',
        resourceType: 'scheduleRule',
        resourceId: id,
        version: 0,
      },
      session,
    );
    return { id, version: 0 };
  });
}
export async function changeScheduleState(
  actor: CommandActor,
  organizationId: string,
  scheduleId: string,
  input: z.infer<typeof offeringStateInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'scheduling.manage');
  return command(
    actor,
    organizationId,
    `schedule.state:${scheduleId}`,
    key,
    input,
    async (session) => {
      const schedule = await ScheduleRule.findOne({
        _id: scheduleId,
        organizationId,
        version: input.expectedVersion,
      }).session(session);
      if (!schedule) conflict();
      const { membership } = await authorizeOrganization(
        actor,
        organizationId,
        'scheduling.manage',
        { facilityId: String(schedule.facilityId), session },
      );
      await lockMembership(membership._id, session);
      if (
        input.status === 'INACTIVE' &&
        (await Appointment.exists({
          scheduleRuleId: scheduleId,
          endAt: { $gt: new Date() },
          $or: [
            { status: { $in: ['CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS'] } },
            { status: 'HELD', holdExpiresAt: { $gt: new Date() } },
          ],
        }).session(session))
      )
        conflict('Resolve affected appointments before deactivating their schedule');
      schedule.status = input.status;
      schedule.updatedBy = { kind: 'USER', id: actor.userId };
      await schedule.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          action: 'ScheduleStateChanged',
          resourceType: 'scheduleRule',
          resourceId: scheduleId,
          version: schedule.version,
          reason: input.reason,
        },
        session,
      );
      return { id: scheduleId, version: schedule.version };
    },
  );
}
export async function offeringForBooking(
  offeringId: string,
  session?: ClientSession,
  lock = false,
) {
  const offering = await ServiceOffering.findOne({ _id: offeringId, status: 'ACTIVE' }).session(
    session ?? null,
  );
  if (!offering) throw ApiError.notFound('Service is unavailable');
  const eligibility = await eligibleAffiliation(String(offering.doctorAffiliationId), session, {
    lock,
  });
  if (
    String(offering.organizationId) !== String(eligibility.organization._id) ||
    String(offering.facilityId) !== String(eligibility.facility._id)
  )
    throw ApiError.notFound('Service is unavailable');
  const price = await Price.findOne({
    _id: offering.currentPriceId,
    offeringId,
    organizationId: offering.organizationId,
  }).session(session ?? null);
  if (!price) throw ApiError.notFound('Price is unavailable');
  const resources = await FacilityResource.find({
    _id: { $in: offering.resourceIds },
    organizationId: offering.organizationId,
    facilityId: offering.facilityId,
    status: 'ACTIVE',
  }).session(session ?? null);
  if (resources.length !== offering.resourceIds.length)
    throw ApiError.notFound('Required resource is unavailable');
  if (lock && session) {
    await ServiceOffering.updateOne(
      { _id: offeringId },
      { $inc: { authorizationFence: 1 } },
      { session },
    );
    for (const resource of resources)
      await FacilityResource.updateOne(
        { _id: resource._id },
        { $inc: { authorizationFence: 1 } },
        { session },
      );
  }
  return {
    ...eligibility,
    offering,
    price,
    resourceKeys: [
      `practitioner:${eligibility.practitioner._id}`,
      ...resources.map((r) => `facility-resource:${r._id}`),
    ],
  };
}
export async function reservationPlan(
  offeringId: string,
  startAt: Date,
  session?: ClientSession,
  lock = false,
) {
  if (
    startAt.getUTCSeconds() ||
    startAt.getUTCMilliseconds() ||
    startAt <= new Date() ||
    startAt.getTime() > Date.now() + 90 * 86400_000
  )
    throw ApiError.badRequest('Choose a future whole-minute time within 90 days');
  const context = await offeringForBooking(offeringId, session, lock);
  const local = indiaClock(startAt);
  const rules = await ScheduleRule.find({
    offeringId,
    status: 'ACTIVE',
    effectiveFrom: { $lte: local.date },
    effectiveUntil: { $gte: local.date },
    weekdays: local.weekday,
    startMinute: { $lte: local.minute },
    endMinute: { $gte: local.minute + context.offering.durationMinutes },
  })
    .sort({ _id: 1 })
    .session(session ?? null);
  const rule = rules.find((r) => (local.minute - r.startMinute) % r.stepMinutes === 0);
  if (!rule) throw ApiError.badRequest('Requested time does not match an active schedule');
  if (lock && session)
    await ScheduleRule.updateOne(
      { _id: rule._id },
      { $inc: { authorizationFence: 1 } },
      { session },
    );
  const endAt = new Date(startAt.getTime() + context.offering.durationMinutes * 60_000);
  return {
    ...context,
    rule,
    startAt,
    endAt,
    claimStartAt: new Date(startAt.getTime() - context.offering.bufferBeforeMinutes * 60_000),
    claimEndAt: new Date(endAt.getTime() + context.offering.bufferAfterMinutes * 60_000),
  };
}
export async function availability(offeringId: string, date: string) {
  const context = await offeringForBooking(offeringId);
  const local = indiaClock(atIndiaMinute(date, 0));
  if (
    atIndiaMinute(date, 1440) <= new Date() ||
    atIndiaMinute(date, 0).getTime() > Date.now() + 90 * 86400_000
  )
    throw ApiError.badRequest('Choose a date within the next 90 days');
  const rules = await ScheduleRule.find({
    offeringId,
    status: 'ACTIVE',
    effectiveFrom: { $lte: date },
    effectiveUntil: { $gte: date },
    weekdays: local.weekday,
  }).lean();
  const candidates = new Set<number>();
  for (const rule of rules)
    for (
      let minute = rule.startMinute;
      minute + context.offering.durationMinutes <= rule.endMinute;
      minute += rule.stepMinutes
    )
      candidates.add(minute);
  const claims = await ResourceClaim.find({
    resourceKey: { $in: context.resourceKeys },
    startAt: { $lt: atIndiaMinute(date, 1560) },
    endAt: { $gt: atIndiaMinute(date, -120) },
    ...activeClaimFilter(),
  })
    .select({ startAt: 1, endAt: 1 })
    .lean<Array<{ startAt: Date; endAt: Date }>>();
  const slots = [...candidates]
    .sort((a, b) => a - b)
    .map((minute) => {
      const start = atIndiaMinute(date, minute);
      const end = new Date(start.getTime() + context.offering.durationMinutes * 60_000);
      return {
        startAt: start,
        endAt: end,
        available:
          start > new Date() &&
          !claims.some(
            (claim) =>
              claim.startAt <
                new Date(end.getTime() + context.offering.bufferAfterMinutes * 60_000) &&
              claim.endAt >
                new Date(start.getTime() - context.offering.bufferBeforeMinutes * 60_000),
          ),
      };
    });
  return {
    offeringId,
    offeringVersion: context.offering.version,
    price: publicPrice(context.price),
    timezone: 'Asia/Kolkata',
    slots,
  };
}
function publicPrice(price: {
  _id: Types.ObjectId;
  amountMinor: number;
  taxMinor: number;
  totalMinor: number;
  currency: string;
}) {
  return {
    id: String(price._id),
    amountMinor: price.amountMinor,
    taxMinor: price.taxMinor,
    totalMinor: price.totalMinor,
    currency: price.currency,
  };
}
export async function getPublicOffering(offeringId: string) {
  const { offering, price, doctor, facility, organization } = await offeringForBooking(offeringId);
  return {
    id: offeringId,
    version: offering.version,
    name: offering.name,
    mode: offering.mode,
    durationMinutes: offering.durationMinutes,
    paymentPolicy: offering.paymentPolicy,
    cancellationPolicy: offering.cancellationPolicy,
    price: publicPrice(price),
    doctor: { id: String(doctor._id), name: doctor.publicName },
    facility: { id: String(facility._id), name: facility.name },
    organization: { id: String(organization._id), name: organization.displayName },
  };
}
export async function listOfferings(
  actor: CommandActor,
  organizationId: string,
  query: z.infer<typeof offeringQuery>,
) {
  const { membership } = await authorizeOrganization(actor, organizationId, 'services.manage', {
    facilityId: query.facilityId,
  });
  const rows = await ServiceOffering.find({
    organizationId,
    ...(membership.facilityScope === 'SELECTED'
      ? { facilityId: { $in: membership.facilityIds } }
      : {}),
    ...(query.facilityId ? { facilityId: query.facilityId } : {}),
    ...(query.before ? { _id: { $lt: new Types.ObjectId(query.before) } } : {}),
  })
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean();
  return {
    items: rows.slice(0, query.limit).map(({ _id, ...row }) => ({ id: String(_id), ...row })),
    nextCursor: rows.length > query.limit ? String(rows[query.limit - 1]!._id) : undefined,
  };
}
export async function listResources(actor: CommandActor, organizationId: string, page: Pagination) {
  const { membership } = await authorizeOrganization(actor, organizationId, 'services.manage');
  const rows = await FacilityResource.find({
    organizationId,
    ...(membership.facilityScope === 'SELECTED'
      ? { facilityId: { $in: membership.facilityIds } }
      : {}),
    ...(page.before ? { _id: { $lt: new Types.ObjectId(page.before) } } : {}),
  })
    .sort({ _id: -1 })
    .limit(page.limit + 1)
    .lean();
  return {
    items: rows.slice(0, page.limit).map((row) => ({
      id: String(row._id),
      facilityId: String(row.facilityId),
      kind: row.kind,
      name: row.name,
      status: row.status,
      version: row.version,
    })),
    nextCursor: rows.length > page.limit ? String(rows[page.limit - 1]!._id) : undefined,
  };
}
export async function listSchedules(actor: CommandActor, organizationId: string, page: Pagination) {
  const { membership } = await authorizeOrganization(actor, organizationId, 'scheduling.manage');
  const rows = await ScheduleRule.find({
    organizationId,
    ...(membership.facilityScope === 'SELECTED'
      ? { facilityId: { $in: membership.facilityIds } }
      : {}),
    ...(page.before ? { _id: { $lt: new Types.ObjectId(page.before) } } : {}),
  })
    .sort({ _id: -1 })
    .limit(page.limit + 1)
    .lean();
  return {
    items: rows.slice(0, page.limit).map(({ _id, ...row }) => ({ id: String(_id), ...row })),
    nextCursor: rows.length > page.limit ? String(rows[page.limit - 1]!._id) : undefined,
  };
}
export async function blockDoctorTime(
  actor: CommandActor,
  input: z.infer<typeof blockInput>,
  key: string,
) {
  const { practitioner } = await ownDoctor(actor);
  const resourceKey = `practitioner:${practitioner._id}`;
  const startAt = new Date(input.startAt);
  const endAt = new Date(input.endAt);
  if (endAt <= new Date()) throw ApiError.badRequest('Leave must affect future time');
  await ensureCalendars([resourceKey], startAt, endAt);
  return command(actor, 'self', 'doctor.time.block', key, input, async (session) => {
    await ownDoctor(actor, session);
    await lockCalendars([resourceKey], startAt, endAt, session);
    const [block] = await ScheduleException.create(
      [
        {
          ...stamp(actor.userId),
          practitionerId: practitioner._id,
          resourceKey,
          startAt,
          endAt,
          reason: input.reason,
        },
      ],
      { session },
    );
    const id = String(block!._id);
    await ResourceClaim.create(
      [{ resourceKey, blockId: id, token: id, startAt, endAt, state: 'CONFIRMED' }],
      { session },
    );
    const affected = await Appointment.find({
      practitionerId: practitioner._id,
      claimStartAt: { $lt: endAt },
      claimEndAt: { $gt: startAt },
      status: { $in: ['HELD', 'CONFIRMED', 'CHECKED_IN'] },
    }).session(session);
    for (const appointment of affected) {
      appointment.requiresReassignment = true;
      appointment.updatedBy = { kind: 'USER', id: actor.userId };
      await appointment.save({ session });
      await recordChange(
        actor,
        {
          organizationId: String(appointment.organizationId),
          patientId: String(appointment.patientId),
          action: 'AppointmentRequiresReassignment',
          resourceType: 'appointment',
          resourceId: String(appointment._id),
          version: appointment.version,
        },
        session,
      );
    }
    await recordChange(
      actor,
      {
        action: 'DoctorTimeBlocked',
        resourceType: 'scheduleException',
        resourceId: id,
        version: 0,
        reason: input.reason,
      },
      session,
    );
    return { id, version: 0 };
  });
}
export async function cancelTimeBlock(
  actor: CommandActor,
  blockId: string,
  expectedVersion: number,
  key: string,
) {
  const { practitioner } = await ownDoctor(actor);
  const block = await ScheduleException.findOne({ _id: blockId, practitionerId: practitioner._id });
  if (!block) throw ApiError.notFound();
  return command(
    actor,
    'self',
    `doctor.time.unblock:${blockId}`,
    key,
    { expectedVersion },
    async (session) => {
      const current = await ScheduleException.findOne({
        _id: blockId,
        practitionerId: practitioner._id,
        version: expectedVersion,
        status: 'ACTIVE',
      }).session(session);
      if (!current) conflict();
      await lockCalendars([current.resourceKey], current.startAt, current.endAt, session);
      current.status = 'CANCELLED';
      current.updatedBy = { kind: 'USER', id: actor.userId };
      await current.save({ session });
      await ResourceClaim.updateMany(
        { blockId, state: 'CONFIRMED' },
        { $set: { state: 'RELEASED' } },
        { session },
      );
      await recordChange(
        actor,
        {
          action: 'DoctorTimeBlockCancelled',
          resourceType: 'scheduleException',
          resourceId: blockId,
          version: current.version,
        },
        session,
      );
      return { id: blockId, version: current.version };
    },
  );
}
