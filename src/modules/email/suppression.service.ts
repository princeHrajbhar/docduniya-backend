import mongoose from 'mongoose';
import { escapeRegExp } from '../../utils/mongo.js';
import { EmailLog, EmailSuppression } from './email.model.js';
import type { EmailLogQuery } from './email.validation.js';

const normalize = (email: string) => email.trim().toLowerCase();

export async function blockEmail(email: string, reason: string | undefined, actorUserId: string) {
  const normalized = normalize(email);
  const record = await EmailSuppression.findOneAndUpdate(
    { email: normalized },
    {
      $set: {
        ...(reason !== undefined ? { reason } : {}),
        blockedBy: new mongoose.Types.ObjectId(actorUserId),
      },
      $setOnInsert: { email: normalized },
    },
    { upsert: true, returnDocument: 'after', runValidators: true },
  ).lean();
  return { ...record, id: String(record?._id) };
}

export async function unblockEmail(email: string) {
  const normalized = normalize(email);
  const deleted = await EmailSuppression.findOneAndDelete({ email: normalized }).lean();
  return { email: normalized, unblocked: Boolean(deleted) };
}

export async function getEmailPreference(email: string) {
  const normalized = normalize(email);
  const record = await EmailSuppression.findOne({ email: normalized }).lean();
  return {
    email: normalized,
    blocked: Boolean(record),
    reason: record?.reason,
    blockedAt: record?.createdAt,
  };
}

export async function listSuppressions(page: number, limit: number, search?: string) {
  const filter = search ? { email: { $regex: escapeRegExp(search), $options: 'i' } } : {};
  const [data, total] = await Promise.all([
    EmailSuppression.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    EmailSuppression.countDocuments(filter),
  ]);
  return {
    data: data.map((record) => ({ ...record, id: String(record._id) })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function listEmailLogs(query: EmailLogQuery) {
  const filter: Record<string, unknown> = {};
  if (query.status) filter.status = query.status;
  if (query.template) filter.template = query.template;
  if (query.search) filter.to = { $regex: escapeRegExp(query.search), $options: 'i' };

  const [data, total] = await Promise.all([
    EmailLog.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean(),
    EmailLog.countDocuments(filter),
  ]);
  return {
    data: data.map((record) => ({ ...record, id: String(record._id) })),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  };
}
