import type { ClientSession } from 'mongoose';
import { ApiError } from '../../utils/api-error.js';
import { isDuplicateKeyError } from '../../utils/mongo.js';
import { ResourceCalendarDay, ResourceClaim } from './scheduling.model.js';

export function daysTouched(start: Date, end: Date): string[] {
  if (end <= start || end.getTime() - start.getTime() > 91 * 86400_000)
    throw ApiError.badRequest('Invalid reservation interval');
  const days: string[] = [];
  const cursor = new Date(`${start.toISOString().slice(0, 10)}T00:00:00Z`);
  while (cursor < end) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}
export async function ensureCalendars(
  resourceKeys: string[],
  start: Date,
  end: Date,
): Promise<void> {
  for (const resourceKey of [...new Set(resourceKeys)].sort())
    for (const day of daysTouched(start, end)) {
      try {
        await ResourceCalendarDay.updateOne(
          { resourceKey, day },
          { $setOnInsert: { fence: 0 } },
          { upsert: true },
        );
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
      }
    }
}
export async function lockCalendars(
  resourceKeys: string[],
  start: Date,
  end: Date,
  session: ClientSession,
): Promise<void> {
  for (const resourceKey of [...new Set(resourceKeys)].sort())
    for (const day of daysTouched(start, end)) {
      const result = await ResourceCalendarDay.updateOne(
        { resourceKey, day },
        { $inc: { fence: 1 } },
        { session },
      );
      if (!result.matchedCount)
        throw new ApiError(
          409,
          'Calendar changed; request a fresh reservation',
          undefined,
          'CALENDAR_RETRY',
        );
    }
}
/** A HELD claim blocks the interval only while its authoritative expiry is in the future. */
export function activeClaimFilter(now = new Date()) {
  return {
    $or: [{ state: 'CONFIRMED' as const }, { state: 'HELD' as const, expiresAt: { $gt: now } }],
  };
}
export async function assertNoOverlap(
  resourceKeys: string[],
  start: Date,
  end: Date,
  session?: ClientSession,
  exceptAppointmentId?: string,
) {
  const conflict = await ResourceClaim.exists({
    resourceKey: { $in: resourceKeys },
    startAt: { $lt: end },
    endAt: { $gt: start },
    ...activeClaimFilter(),
    ...(exceptAppointmentId ? { appointmentId: { $ne: exceptAppointmentId } } : {}),
  }).session(session ?? null);
  if (conflict)
    throw new ApiError(409, 'This time is no longer available', undefined, 'SLOT_UNAVAILABLE');
}
export function indiaClock(date: Date) {
  const local = new Date(date.getTime() + 330 * 60_000);
  return {
    date: local.toISOString().slice(0, 10),
    weekday: local.getUTCDay(),
    minute: local.getUTCHours() * 60 + local.getUTCMinutes(),
  };
}
export function atIndiaMinute(date: string, minute: number): Date {
  return new Date(new Date(`${date}T00:00:00+05:30`).getTime() + minute * 60_000);
}
