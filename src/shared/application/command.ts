import { createHash } from 'node:crypto';
import mongoose, { type ClientSession } from 'mongoose';
import { ApiError } from '../../utils/api-error.js';
import type { CommandActor, CommandResult } from '../domain/healthcare.js';
import { IdempotencyKey } from '../../modules/operations/operation.model.js';
import { isDuplicateKeyError } from '../../utils/mongo.js';

/** Deterministic JSON with sorted keys; used for request hashes and signed clinical snapshots. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(',')}}`;
}

export async function transaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
  try {
    return await mongoose.connection.transaction(work, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      maxCommitTimeMS: 10_000,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      /Transaction numbers are only allowed|replica set|mongos/.test(error.message)
    ) {
      throw new ApiError(
        503,
        'This operation requires a MongoDB replica set. Run the local database setup or configure a replica-set connection.',
        undefined,
        'TRANSACTIONS_REQUIRED',
      );
    }
    throw error;
  }
}

export async function command(
  actor: CommandActor,
  scope: string,
  operation: string,
  key: string,
  input: unknown,
  work: (session: ClientSession) => Promise<CommandResult>,
): Promise<CommandResult> {
  const query = { scopeKey: scope, actorId: actor.userId, operation, key };
  const requestHash = createHash('sha256').update(canonical(input)).digest('hex');
  const replay = (record: { requestHash: string; result: { id: string; version: number } }) => {
    if (record.requestHash !== requestHash)
      throw new ApiError(
        409,
        'Idempotency key was already used for a different request',
        undefined,
        'IDEMPOTENCY_CONFLICT',
      );
    return { id: record.result.id, version: record.result.version };
  };
  try {
    return await transaction(async (session) => {
      const previous = await IdempotencyKey.findOne(query).session(session).lean();
      if (previous) return replay(previous);
      const result = await work(session);
      await IdempotencyKey.create([{ ...query, requestHash, result }], { session });
      return result;
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      const previous = await IdempotencyKey.findOne(query).lean();
      if (previous) return replay(previous);
    }
    throw error;
  }
}

export function conflict(message = 'The record changed. Reload it and retry.'): never {
  throw new ApiError(409, message, undefined, 'VERSION_CONFLICT');
}
