import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { transaction } from '../../shared/application/command.js';
import type { CommandActor, Pagination } from '../../shared/domain/healthcare.js';
import { before, pageOf } from '../../shared/application/scope.js';
import { ApiError } from '../../utils/api-error.js';
import { isDuplicateKeyError } from '../../utils/mongo.js';
import { logger } from '../../config/logger.js';
import { requirePlatformPermission } from '../access/platform-access.js';
import { PERMISSIONS } from '../admin/auth/roles/permission.constants.js';
import { ProcessedEvent } from '../notifications/notification.model.js';
import { notificationConsumer } from '../notifications/notification.service.js';
import { OutboxEvent } from './operation.model.js';

export interface DomainEvent {
  eventId: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  organizationId?: string;
}
type Consumer = {
  name: string;
  handle: (event: DomainEvent, session: ClientSession) => Promise<void>;
};

/** Registered consumers. Each commits its effect together with its processed-event marker. */
const consumers: Consumer[] = [{ name: 'notifications', handle: notificationConsumer }];
export function registerConsumer(consumer: Consumer): void {
  if (!consumers.some((entry) => entry.name === consumer.name)) consumers.push(consumer);
}

const MAX_ATTEMPTS = 10;

/**
 * Leases pending events and delivers them to every consumer at least once. A crash after a
 * consumer commits but before acknowledgement is harmless: the marker deduplicates the replay.
 */
export async function relayOutbox(limit = 50): Promise<number> {
  let relayed = 0;
  for (let index = 0; index < limit; index += 1) {
    const now = new Date();
    const leaseToken = randomUUID();
    const event = await OutboxEvent.findOneAndUpdate(
      {
        $or: [
          { state: 'PENDING', availableAt: { $lte: now } },
          { state: 'LEASED', leaseUntil: { $lt: now } },
        ],
      },
      {
        $set: { state: 'LEASED', leaseToken, leaseUntil: new Date(now.getTime() + 60_000) },
        $inc: { attempts: 1 },
      },
      { returnDocument: 'after', sort: { availableAt: 1 } },
    );
    if (!event) break;
    const domainEvent: DomainEvent = {
      eventId: event.eventId,
      type: event.type,
      aggregateType: event.aggregateType,
      aggregateId: String(event.aggregateId),
      aggregateVersion: event.aggregateVersion,
      organizationId: event.organizationId ? String(event.organizationId) : undefined,
    };
    try {
      for (const consumer of consumers) {
        if (await ProcessedEvent.exists({ consumer: consumer.name, eventId: event.eventId }))
          continue;
        try {
          await transaction(async (session) => {
            await ProcessedEvent.create([{ consumer: consumer.name, eventId: event.eventId }], {
              session,
            });
            await consumer.handle(domainEvent, session);
          });
        } catch (error) {
          if (!isDuplicateKeyError(error)) throw error;
        }
      }
      await OutboxEvent.updateOne(
        { _id: event._id, leaseToken },
        {
          $set: { state: 'PUBLISHED', publishedAt: new Date() },
          $unset: { leaseToken: 1, leaseUntil: 1 },
        },
      );
      relayed += 1;
    } catch (error) {
      logger.warn(
        { err: error, eventId: event.eventId, type: event.type },
        'Outbox delivery failed',
      );
      const failed = event.attempts >= MAX_ATTEMPTS;
      await OutboxEvent.updateOne(
        { _id: event._id, leaseToken },
        {
          $set: {
            state: failed ? 'FAILED' : 'PENDING',
            availableAt: new Date(
              Date.now() +
                Math.min(2 ** event.attempts, 256) * 1000 +
                Math.floor(Math.random() * 1000),
            ),
          },
          $unset: { leaseToken: 1, leaseUntil: 1 },
        },
      );
    }
  }
  return relayed;
}

/** Dead-letter view and replay for operators. Replay is safe because consumers deduplicate. */
export async function listFailedEvents(actor: CommandActor, page: Pagination) {
  await requirePlatformPermission(actor, PERMISSIONS.OPERATIONS_MANAGE);
  const rows = await OutboxEvent.find({ state: 'FAILED', ...before(page.before) })
    .sort({ _id: -1 })
    .limit(page.limit + 1)
    .lean();
  return pageOf(rows, page.limit, (row) => ({
    id: String(row._id),
    eventId: row.eventId,
    type: row.type,
    aggregateType: row.aggregateType,
    aggregateId: String(row.aggregateId),
    attempts: row.attempts,
    occurredAt: row.occurredAt,
  }));
}

export async function replayEvent(actor: CommandActor, id: string) {
  await requirePlatformPermission(actor, PERMISSIONS.OPERATIONS_MANAGE);
  const result = await OutboxEvent.updateOne(
    { _id: id, state: 'FAILED' },
    { $set: { state: 'PENDING', availableAt: new Date(), attempts: 0 } },
  );
  if (!result.modifiedCount) throw ApiError.notFound('Failed event is unavailable');
  return { id, state: 'PENDING' };
}

/** Operational health: outbox lag and backlog, for monitoring and readiness checks. */
export async function outboxHealth() {
  const [pending, failed, oldest] = await Promise.all([
    OutboxEvent.countDocuments({ state: { $in: ['PENDING', 'LEASED'] } }),
    OutboxEvent.countDocuments({ state: 'FAILED' }),
    OutboxEvent.findOne({ state: 'PENDING' })
      .sort({ availableAt: 1 })
      .select({ occurredAt: 1 })
      .lean(),
  ]);
  return {
    pending,
    failed,
    oldestPendingAgeSeconds: oldest
      ? Math.round((Date.now() - oldest.occurredAt.getTime()) / 1000)
      : 0,
  };
}
