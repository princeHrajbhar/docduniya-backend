import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CommandActor } from '../../shared/domain/healthcare.js';
import { objectId, todayInIndia } from '../../shared/domain/healthcare.js';
import { command, conflict, transaction } from '../../shared/application/command.js';
import { presentRow, serviceActor } from '../../shared/application/scope.js';
import { stamp } from '../../shared/persistence/schema.js';
import { logger } from '../../config/logger.js';
import { ApiError } from '../../utils/api-error.js';
import { authorizeOrganization } from '../access/access.service.js';
import { authorizePatient } from '../patients/patient.service.js';
import { recordChange } from '../operations/operation.service.js';
import { availability, offeringForBooking } from '../scheduling/scheduling.service.js';
import { createHold } from './appointment.service.js';
import { WaitlistEntry } from './waitlist.model.js';

const OFFER_MINUTES = 30;
const MAX_OFFERS = 3;
const day = z.iso.date();

export const waitlistInput = z
  .strictObject({
    patientId: objectId,
    offeringId: objectId,
    earliestDate: day,
    latestDate: day,
  })
  .refine((v) => v.earliestDate <= v.latestDate, { message: 'The range must end after it starts' });
export const waitlistCancel = z.strictObject({ expectedVersion: z.number().int().min(0) });

const service = (name: string) => ({ kind: 'SERVICE' as const, id: name });

export async function joinWaitlist(
  actor: CommandActor,
  input: z.infer<typeof waitlistInput>,
  key: string,
) {
  await authorizePatient(actor, input.patientId, 'registration.create');
  const today = todayInIndia();
  const horizon = todayInIndia(new Date(Date.now() + 90 * 86400_000));
  if (input.latestDate < today || input.earliestDate > horizon)
    throw ApiError.badRequest('Choose dates within the next 90 days');
  const { offering } = await offeringForBooking(input.offeringId);
  return command(
    actor,
    'self',
    `waitlist.join:${input.offeringId}`,
    key,
    input,
    async (session) => {
      await authorizePatient(actor, input.patientId, 'registration.create', session, true);
      if (
        await WaitlistEntry.exists({
          patientId: input.patientId,
          offeringId: input.offeringId,
          status: { $in: ['WAITING', 'OFFERED'] },
        }).session(session)
      )
        conflict('You are already on the waitlist for this service');
      const [row] = await WaitlistEntry.create(
        [
          {
            ...stamp(actor.userId),
            organizationId: offering.organizationId,
            facilityId: offering.facilityId,
            offeringId: offering._id,
            patientId: input.patientId,
            requestedBy: actor.userId,
            earliestDate: input.earliestDate < today ? today : input.earliestDate,
            latestDate: input.latestDate,
          },
        ],
        { session },
      );
      await recordChange(
        actor,
        {
          organizationId: String(offering.organizationId),
          patientId: input.patientId,
          action: 'WaitlistJoined',
          resourceType: 'waitlistEntry',
          resourceId: String(row!._id),
          version: 0,
        },
        session,
      );
      return { id: String(row!._id), version: 0 };
    },
  );
}

export async function leaveWaitlist(
  actor: CommandActor,
  entryId: string,
  input: z.infer<typeof waitlistCancel>,
  key: string,
) {
  const preview = await WaitlistEntry.findById(entryId);
  if (!preview) throw ApiError.notFound();
  await authorizePatient(actor, String(preview.patientId), 'registration.create');
  return command(actor, 'self', `waitlist.leave:${entryId}`, key, input, async (session) => {
    const row = await WaitlistEntry.findOne({
      _id: entryId,
      version: input.expectedVersion,
      status: { $in: ['WAITING', 'OFFERED'] },
    }).session(session);
    if (!row) conflict();
    row.status = 'CANCELLED';
    row.closedReason = 'Left by patient';
    row.updatedBy = { kind: 'USER', id: actor.userId };
    await row.save({ session });
    return { id: entryId, version: row.version };
  });
}

export async function patientWaitlist(actor: CommandActor, patientId: string) {
  await authorizePatient(actor, patientId, 'profile.read');
  const rows = await WaitlistEntry.find({ patientId }).sort({ _id: -1 }).limit(50).lean();
  return { items: rows.map(presentRow) };
}

export async function providerWaitlist(
  actor: CommandActor,
  organizationId: string,
  offeringId: string,
) {
  await authorizeOrganization(actor, organizationId, 'appointments.read');
  const rows = await WaitlistEntry.find({
    organizationId,
    offeringId,
    status: { $in: ['WAITING', 'OFFERED'] },
  })
    .sort({ _id: 1 })
    .limit(200)
    .lean();
  // Staff see position and dates; contact happens through the platform notification.
  return {
    items: rows.map((row, index) => ({
      id: String(row._id),
      position: index + 1,
      patientId: String(row.patientId),
      earliestDate: row.earliestDate,
      latestDate: row.latestDate,
      status: row.status,
      offerStartAt: row.offerStartAt,
      offerExpiresAt: row.offerExpiresAt,
    })),
  };
}

/** Lapsed offers return to the queue (up to three offers); past ranges expire. */
async function expireOffers(now: Date) {
  const lapsed = await WaitlistEntry.find({ status: 'OFFERED', offerExpiresAt: { $lte: now } })
    .limit(200)
    .lean();
  for (const row of lapsed)
    await WaitlistEntry.updateOne(
      { _id: row._id, status: 'OFFERED', version: row.version },
      row.offerCount >= MAX_OFFERS
        ? {
            $set: {
              status: 'EXPIRED',
              closedReason: 'Offers not accepted',
              updatedBy: service('waitlist'),
            },
            $unset: { offerStartAt: 1, offerExpiresAt: 1 },
            $inc: { version: 1 },
          }
        : {
            $set: { status: 'WAITING', updatedBy: service('waitlist') },
            $unset: { offerStartAt: 1, offerExpiresAt: 1 },
            $inc: { version: 1 },
          },
    );
  await WaitlistEntry.updateMany(
    { status: 'WAITING', latestDate: { $lt: todayInIndia(now) } },
    {
      $set: {
        status: 'EXPIRED',
        closedReason: 'Date range passed',
        updatedBy: service('waitlist'),
      },
      $inc: { version: 1 },
    },
  );
}

/**
 * Worker: offers the earliest free slot to the longest-waiting patient of each service. The
 * partial unique index on (offering, slot) guarantees one open offer per slot across instances.
 */
export async function offerWaitlistSlots(limit = 50): Promise<number> {
  const now = new Date();
  await expireOffers(now);
  const waiting = await WaitlistEntry.find({ status: 'WAITING' })
    .sort({ _id: 1 })
    .limit(limit)
    .lean();
  let offered = 0;
  const slotCache = new Map<string, Array<{ startAt: Date; available: boolean }>>();
  for (const entry of waiting) {
    const taken = new Set(
      (
        await WaitlistEntry.find({ offeringId: entry.offeringId, status: 'OFFERED' })
          .select({ offerStartAt: 1 })
          .lean()
      ).map((row) => row.offerStartAt?.toISOString()),
    );
    let slot: Date | undefined;
    const start = entry.earliestDate > todayInIndia(now) ? entry.earliestDate : todayInIndia(now);
    for (
      let date = start, guard = 0;
      date <= entry.latestDate && guard < 14 && !slot;
      date = todayInIndia(new Date(new Date(`${date}T12:00:00+05:30`).getTime() + 86400_000)),
        guard += 1
    ) {
      const cacheKey = `${String(entry.offeringId)}:${date}`;
      if (!slotCache.has(cacheKey)) {
        try {
          slotCache.set(cacheKey, (await availability(String(entry.offeringId), date)).slots);
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          slotCache.set(cacheKey, []);
        }
      }
      slot = slotCache
        .get(cacheKey)!
        .find(
          (candidate) => candidate.available && !taken.has(candidate.startAt.toISOString()),
        )?.startAt;
    }
    if (!slot) continue;
    try {
      const offeredRow = await transaction(async (session) => {
        const row = await WaitlistEntry.findOneAndUpdate(
          { _id: entry._id, status: 'WAITING', version: entry.version },
          {
            $set: {
              status: 'OFFERED',
              offerStartAt: slot,
              offerExpiresAt: new Date(now.getTime() + OFFER_MINUTES * 60_000),
              updatedBy: service('waitlist'),
            },
            $inc: { offerCount: 1, version: 1 },
          },
          { session, returnDocument: 'after' },
        );
        if (!row) return null;
        await recordChange(
          serviceActor('waitlist', randomUUID()),
          {
            organizationId: String(row.organizationId),
            patientId: String(row.patientId),
            action: 'WaitlistSlotOffered',
            resourceType: 'waitlistEntry',
            resourceId: String(row._id),
            version: row.version,
          },
          session,
        );
        return row;
      });
      if (offeredRow) offered += 1;
    } catch (error) {
      // Another instance offered this slot first.
      if ((error as { code?: number }).code !== 11000) throw error;
      logger.debug({ entryId: entry._id }, 'Waitlist slot already offered');
    }
  }
  return offered;
}

/** Accepting places an ordinary hold at the current price; payment then follows the booking flow. */
export async function acceptOffer(actor: CommandActor, entryId: string, key: string) {
  const entry = await WaitlistEntry.findById(entryId);
  if (!entry) throw ApiError.notFound();
  await authorizePatient(actor, String(entry.patientId), 'registration.create');
  if (entry.status === 'BOOKED' && entry.appointmentId)
    return { id: entryId, appointmentId: String(entry.appointmentId) };
  if (entry.status !== 'OFFERED' || !entry.offerStartAt || entry.offerExpiresAt! <= new Date())
    conflict('This offer is no longer available');
  const quote = await availability(String(entry.offeringId), todayInIndia(entry.offerStartAt));
  const hold = await createHold(
    actor,
    {
      patientId: String(entry.patientId),
      offeringId: String(entry.offeringId),
      offeringVersion: quote.offeringVersion,
      priceId: quote.price.id,
      startAt: entry.offerStartAt.toISOString(),
    },
    `waitlist:${entryId}:${key}`,
  ).catch(async (error: unknown) => {
    // The slot was taken by a direct booking: return the patient to the queue.
    await WaitlistEntry.updateOne(
      { _id: entryId, status: 'OFFERED' },
      {
        $set: { status: 'WAITING', updatedBy: { kind: 'USER', id: actor.userId } },
        $unset: { offerStartAt: 1, offerExpiresAt: 1 },
        $inc: { version: 1 },
      },
    );
    throw error;
  });
  await WaitlistEntry.updateOne(
    { _id: entryId, status: 'OFFERED' },
    {
      $set: {
        status: 'BOOKED',
        appointmentId: hold.id,
        updatedBy: { kind: 'USER', id: actor.userId },
      },
      $unset: { offerExpiresAt: 1 },
      $inc: { version: 1 },
    },
  );
  return { id: entryId, appointmentId: hold.id };
}
