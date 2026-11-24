import { randomUUID } from 'node:crypto';
import { Schema, model } from 'mongoose';
import { z } from 'zod';
import type { CommandActor, Pagination } from '../../shared/domain/healthcare.js';
import { label, objectId, version } from '../../shared/domain/healthcare.js';
import { command, conflict, transaction } from '../../shared/application/command.js';
import { before, pageOf, scoped, serviceActor } from '../../shared/application/scope.js';
import {
  aggregateOptions,
  actorSchema,
  bounded,
  metadataFields,
  ref,
  stamp,
} from '../../shared/persistence/schema.js';
import { ApiError } from '../../utils/api-error.js';
import { isDuplicateKeyError } from '../../utils/mongo.js';
import { authorizeOrganization } from '../access/access.service.js';
import { requirePlatformPermission } from '../access/platform-access.js';
import { PERMISSIONS } from '../admin/auth/roles/permission.constants.js';
import { recordChange } from '../operations/operation.service.js';

const value = { _id: false, strict: 'throw', versionKey: false } as const;
const entitlementSchema = new Schema(
  { feature: { type: String, required: true, maxlength: 60 }, limit: { type: Number, min: 0 } },
  value,
);

const planSchema = new Schema(
  {
    code: { type: String, required: true, maxlength: 60 },
    versionNumber: { type: Number, required: true, min: 1 },
    name: { type: String, required: true, maxlength: 200 },
    period: { type: String, enum: ['MONTH', 'YEAR'], required: true },
    priceMinor: { type: Number, required: true, min: 0 },
    currency: { type: String, enum: ['INR'], default: 'INR' },
    trialDays: { type: Number, default: 0, min: 0, max: 90 },
    entitlements: { type: [entitlementSchema], default: [], validate: bounded(100) },
    effectiveFrom: { type: Date, required: true },
    retiredAt: Date,
    approvedBy: { type: actorSchema, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { strict: 'throw', versionKey: false, autoIndex: false, autoCreate: false },
);
planSchema.index({ code: 1, versionNumber: 1 }, { unique: true });
export const SubscriptionPlan = model('SubscriptionPlan', planSchema, 'subscriptionPlans');

const subscriptionSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    planId: ref('SubscriptionPlan'),
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    current: { type: Boolean, required: true },
    status: {
      type: String,
      enum: ['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED', 'ENDED'],
      required: true,
    },
    renewalMode: { type: String, enum: ['AUTO', 'MANUAL'], default: 'AUTO' },
    paidThrough: Date,
    graceEndsAt: Date,
    cancelAtPeriodEnd: { type: Boolean, default: false },
    entitlementOverrides: {
      type: [
        new Schema(
          {
            feature: { type: String, required: true },
            limit: Number,
            expiresAt: { type: Date, required: true },
          },
          value,
        ),
      ],
      default: [],
      validate: bounded(30),
    },
  },
  aggregateOptions,
);
subscriptionSchema.index(
  { organizationId: 1, current: 1 },
  { unique: true, partialFilterExpression: { current: true } },
);
subscriptionSchema.index({ current: 1, periodEnd: 1 });
export const Subscription = model('Subscription', subscriptionSchema, 'subscriptions');

export const planInput = z.strictObject({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{2,59}$/),
  name: label,
  period: z.enum(['MONTH', 'YEAR']),
  priceMinor: z.number().int().min(0).max(100_000_000),
  trialDays: z.number().int().min(0).max(90).default(0),
  entitlements: z
    .array(
      z.strictObject({
        feature: z.string().regex(/^[a-z][a-z0-9-]{1,59}$/),
        limit: z.number().int().min(0).optional(),
      }),
    )
    .max(100),
  effectiveFrom: z.iso.datetime(),
});
export const subscribeInput = z.strictObject({
  planId: objectId,
  renewalMode: z.enum(['AUTO', 'MANUAL']).default('AUTO'),
});
export const subscriptionActionInput = z.strictObject({
  expectedVersion: version,
  action: z.enum(['cancel-at-period-end', 'resume', 'change-plan']),
  planId: objectId.optional(),
});
export const subscriptionPaymentInput = z.strictObject({
  expectedVersion: version,
  paidThrough: z.iso.datetime(),
  reference: z.string().trim().min(3).max(100),
});

const addPeriod = (start: Date, period: 'MONTH' | 'YEAR') => {
  const end = new Date(start);
  if (period === 'MONTH') end.setUTCMonth(end.getUTCMonth() + 1);
  else end.setUTCFullYear(end.getUTCFullYear() + 1);
  return end;
};
const GRACE_DAYS = 7;

export async function publishPlan(
  actor: CommandActor,
  input: z.infer<typeof planInput>,
  key: string,
) {
  await requirePlatformPermission(actor, PERMISSIONS.COMMERCE_MANAGE);
  return command(actor, 'platform', 'plan.publish', key, input, async (session) => {
    const latest = await SubscriptionPlan.findOne({ code: input.code })
      .sort({ versionNumber: -1 })
      .session(session);
    if (latest && !latest.retiredAt)
      await SubscriptionPlan.collection.updateOne(
        { _id: latest._id },
        { $set: { retiredAt: new Date(input.effectiveFrom) } },
        { session },
      );
    const [plan] = await SubscriptionPlan.create(
      [
        {
          ...input,
          versionNumber: (latest?.versionNumber ?? 0) + 1,
          effectiveFrom: new Date(input.effectiveFrom),
          approvedBy: { kind: 'USER', id: actor.userId },
        },
      ],
      { session },
    );
    await recordChange(
      actor,
      {
        action: 'SubscriptionPlanPublished',
        resourceType: 'subscriptionPlan',
        resourceId: String(plan!._id),
        version: 0,
      },
      session,
    );
    return { id: String(plan!._id), version: 0 };
  });
}

export async function listPlans() {
  const now = new Date();
  const rows = await SubscriptionPlan.find({
    effectiveFrom: { $lte: now },
    $or: [{ retiredAt: { $exists: false } }, { retiredAt: { $gt: now } }],
  })
    .sort({ priceMinor: 1 })
    .lean();
  return rows.map((row) => ({
    id: String(row._id),
    code: row.code,
    versionNumber: row.versionNumber,
    name: row.name,
    period: row.period,
    priceMinor: row.priceMinor,
    currency: row.currency,
    trialDays: row.trialDays,
    entitlements: row.entitlements,
  }));
}

/** One current subscription per provider. Commercial status never removes clinical records. */
export async function subscribe(
  actor: CommandActor,
  organizationId: string,
  input: z.infer<typeof subscribeInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'subscriptions.manage', {
    organizationWide: true,
  });
  try {
    return await command(
      actor,
      organizationId,
      'subscription.start',
      key,
      input,
      async (session) => {
        await scoped(actor, organizationId, 'subscriptions.manage', session, {
          organizationWide: true,
        });
        const plan = await SubscriptionPlan.findOne({
          _id: input.planId,
          effectiveFrom: { $lte: new Date() },
          $or: [{ retiredAt: { $exists: false } }, { retiredAt: { $gt: new Date() } }],
        }).session(session);
        if (!plan) throw ApiError.notFound('Plan is unavailable');
        const start = new Date();
        const trial =
          plan.trialDays > 0 && !(await Subscription.exists({ organizationId }).session(session));
        const end = trial
          ? new Date(start.getTime() + plan.trialDays * 86400_000)
          : addPeriod(start, plan.period);
        const [subscription] = await Subscription.create(
          [
            {
              ...stamp(actor.userId),
              organizationId,
              planId: plan._id,
              periodStart: start,
              periodEnd: end,
              current: true,
              status: trial ? 'TRIAL' : plan.priceMinor === 0 ? 'ACTIVE' : 'PAST_DUE',
              renewalMode: input.renewalMode,
              paidThrough: plan.priceMinor === 0 ? end : undefined,
              graceEndsAt:
                trial || plan.priceMinor === 0
                  ? undefined
                  : new Date(start.getTime() + GRACE_DAYS * 86400_000),
            },
          ],
          { session },
        );
        await recordChange(
          actor,
          {
            organizationId,
            action: 'SubscriptionChanged',
            resourceType: 'subscription',
            resourceId: String(subscription!._id),
            version: 0,
          },
          session,
        );
        return { id: String(subscription!._id), version: 0 };
      },
    );
  } catch (error) {
    if (isDuplicateKeyError(error)) conflict('The provider already has a current subscription');
    throw error;
  }
}

export async function actOnSubscription(
  actor: CommandActor,
  organizationId: string,
  subscriptionId: string,
  input: z.infer<typeof subscriptionActionInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'subscriptions.manage', {
    organizationWide: true,
  });
  return command(
    actor,
    organizationId,
    `subscription.${input.action}:${subscriptionId}`,
    key,
    input,
    async (session) => {
      await scoped(actor, organizationId, 'subscriptions.manage', session, {
        organizationWide: true,
      });
      const subscription = await Subscription.findOne({
        _id: subscriptionId,
        organizationId,
        version: input.expectedVersion,
        current: true,
      }).session(session);
      if (!subscription) conflict();
      if (input.action === 'cancel-at-period-end') subscription.cancelAtPeriodEnd = true;
      else if (input.action === 'resume') subscription.cancelAtPeriodEnd = false;
      else {
        const plan = await SubscriptionPlan.findOne({
          _id: input.planId,
          effectiveFrom: { $lte: new Date() },
        }).session(session);
        if (!plan) throw ApiError.notFound('Plan is unavailable');
        // Plan changes take effect at the next renewal so the paid period keeps its terms.
        subscription.set('planId', plan._id);
      }
      subscription.updatedBy = { kind: 'USER', id: actor.userId };
      await subscription.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          action: 'SubscriptionChanged',
          resourceType: 'subscription',
          resourceId: subscriptionId,
          version: subscription.version,
          reason: input.action,
        },
        session,
      );
      return { id: subscriptionId, version: subscription.version };
    },
  );
}

/** Platform finance records a verified provider payment for the subscription. */
export async function recordSubscriptionPayment(
  actor: CommandActor,
  subscriptionId: string,
  input: z.infer<typeof subscriptionPaymentInput>,
  key: string,
) {
  await requirePlatformPermission(actor, PERMISSIONS.COMMERCE_MANAGE);
  return command(
    actor,
    'platform',
    `subscription.paid:${subscriptionId}`,
    key,
    input,
    async (session) => {
      const subscription = await Subscription.findOne({
        _id: subscriptionId,
        version: input.expectedVersion,
        current: true,
      }).session(session);
      if (!subscription) conflict();
      subscription.set({
        paidThrough: new Date(input.paidThrough),
        status: 'ACTIVE',
        graceEndsAt: undefined,
        updatedBy: { kind: 'USER', id: actor.userId },
      });
      await subscription.save({ session });
      await recordChange(
        actor,
        {
          organizationId: String(subscription.organizationId),
          action: 'SubscriptionPaymentRecorded',
          resourceType: 'subscription',
          resourceId: subscriptionId,
          version: subscription.version,
          reason: input.reference,
        },
        session,
      );
      return { id: subscriptionId, version: subscription.version };
    },
  );
}

export async function currentSubscription(actor: CommandActor, organizationId: string) {
  await authorizeOrganization(actor, organizationId, 'organization.read');
  const subscription = await Subscription.findOne({ organizationId, current: true }).lean();
  if (!subscription) return { subscription: null, entitlements: [] };
  return {
    subscription: {
      id: String(subscription._id),
      planId: String(subscription.planId),
      status: subscription.status,
      periodStart: subscription.periodStart,
      periodEnd: subscription.periodEnd,
      paidThrough: subscription.paidThrough,
      graceEndsAt: subscription.graceEndsAt,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      version: subscription.version,
    },
    entitlements: await entitlements(organizationId),
  };
}

/** Commercial feature limits. Use only for commercial features, never for safety or record access. */
export async function entitlements(organizationId: string) {
  const subscription = await Subscription.findOne({
    organizationId,
    current: true,
    status: { $in: ['TRIAL', 'ACTIVE', 'PAST_DUE'] },
  }).lean();
  if (!subscription) return [];
  const plan = await SubscriptionPlan.findById(subscription.planId).lean();
  const now = new Date();
  const overrides = subscription.entitlementOverrides.filter((entry) => entry.expiresAt > now);
  const features = new Map((plan?.entitlements ?? []).map((entry) => [entry.feature, entry.limit]));
  for (const override of overrides) features.set(override.feature, override.limit ?? undefined);
  return [...features].map(([feature, limit]) => ({ feature, limit }));
}

/** Renewal and grace transitions. Deterministic and idempotent per subscription version. */
export async function renewSubscriptions(): Promise<number> {
  const now = new Date();
  const due = await Subscription.find({
    current: true,
    $or: [{ periodEnd: { $lte: now } }, { status: 'PAST_DUE', graceEndsAt: { $lte: now } }],
  }).limit(200);
  for (const candidate of due)
    await transaction(async (session) => {
      const subscription = await Subscription.findOne({
        _id: candidate._id,
        version: candidate.version,
      }).session(session);
      if (!subscription) return;
      const plan = await SubscriptionPlan.findById(subscription.planId).session(session);
      const service = { kind: 'SERVICE' as const, id: 'subscription-renewal' };
      if (
        subscription.status === 'PAST_DUE' &&
        subscription.graceEndsAt &&
        subscription.graceEndsAt <= now
      )
        subscription.status = 'SUSPENDED';
      if (subscription.periodEnd <= now) {
        if (subscription.cancelAtPeriodEnd || subscription.renewalMode === 'MANUAL' || !plan) {
          subscription.set({
            status: subscription.cancelAtPeriodEnd ? 'CANCELLED' : 'ENDED',
            current: false,
          });
        } else {
          const nextEnd = addPeriod(subscription.periodEnd, plan.period);
          const paid = subscription.paidThrough && subscription.paidThrough >= nextEnd;
          subscription.set({
            periodStart: subscription.periodEnd,
            periodEnd: nextEnd,
            status: paid || plan.priceMinor === 0 ? 'ACTIVE' : 'PAST_DUE',
            graceEndsAt:
              paid || plan.priceMinor === 0
                ? undefined
                : new Date(subscription.periodEnd.getTime() + GRACE_DAYS * 86400_000),
          });
        }
      }
      subscription.updatedBy = service;
      await subscription.save({ session });
      await recordChange(
        serviceActor('subscription-renewal', randomUUID()),
        {
          organizationId: String(subscription.organizationId),
          action: 'SubscriptionChanged',
          resourceType: 'subscription',
          resourceId: String(subscription._id),
          version: subscription.version,
          reason: subscription.status,
        },
        session,
      );
    });
  return due.length;
}

export async function listSubscriptions(actor: CommandActor, page: Pagination) {
  await requirePlatformPermission(actor, PERMISSIONS.COMMERCE_MANAGE);
  const rows = await Subscription.find({ current: true, ...before(page.before) })
    .sort({ _id: -1 })
    .limit(page.limit + 1)
    .lean();
  return pageOf(rows, page.limit, (row) => ({
    id: String(row._id),
    organizationId: String(row.organizationId),
    planId: String(row.planId),
    status: row.status,
    periodEnd: row.periodEnd,
    paidThrough: row.paidThrough,
    version: row.version,
  }));
}
