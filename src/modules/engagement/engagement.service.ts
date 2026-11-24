import { z } from 'zod';
import type { CommandActor, Pagination } from '../../shared/domain/healthcare.js';
import { label, objectId, paginationInput, version } from '../../shared/domain/healthcare.js';
import { command, conflict } from '../../shared/application/command.js';
import { before, pageOf, scoped } from '../../shared/application/scope.js';
import { stamp } from '../../shared/persistence/schema.js';
import { ApiError } from '../../utils/api-error.js';
import { isDuplicateKeyError } from '../../utils/mongo.js';
import { authorizeOrganization } from '../access/access.service.js';
import { requirePlatformPermission } from '../access/platform-access.js';
import { PERMISSIONS } from '../admin/auth/roles/permission.constants.js';
import { authorizePatient } from '../patients/patient.service.js';
import { Appointment } from '../appointments/appointment.model.js';
import { recordChange } from '../operations/operation.service.js';
import { Review, SupportTicket } from './engagement.model.js';

const reason = z.string().trim().min(5).max(1000);
export const ticketInput = z.strictObject({
  category: z.enum(['BOOKING', 'PROVIDER', 'PAYMENT', 'PRIVACY', 'SAFETY', 'TECHNICAL']),
  subject: label,
  description: z.string().trim().min(10).max(4000),
  organizationId: objectId.optional(),
  patientId: objectId.optional(),
  relatedRefs: z
    .array(
      z.strictObject({
        type: z.enum(['appointment', 'invoice', 'payment', 'refund', 'document']),
        id: objectId,
      }),
    )
    .max(20)
    .default([]),
});
export const ticketReplyInput = z.strictObject({
  expectedVersion: version,
  body: z.string().trim().min(1).max(4000),
});
export const ticketActionInput = z.strictObject({
  expectedVersion: version,
  action: z.enum(['assign', 'wait', 'resolve', 'close', 'reopen']),
  assigneeId: objectId.optional(),
  resolution: z.string().trim().min(5).max(2000).optional(),
});
export const ticketQuery = paginationInput.extend({
  status: z.enum(['OPEN', 'ASSIGNED', 'WAITING', 'RESOLVED', 'CLOSED']).optional(),
});
export const reviewInput = z.strictObject({
  appointmentId: objectId,
  rating: z.number().int().min(1).max(5),
  text: z.string().trim().min(1).max(2000).optional(),
});
export const moderationInput = z.strictObject({
  expectedVersion: version,
  status: z.enum(['PUBLISHED', 'HIDDEN', 'REMOVED']),
  reason,
});
export const replyInput = z.strictObject({
  expectedVersion: version,
  text: z.string().trim().min(1).max(2000),
});

// ── Support ──────────────────────────────────────────────────────────────────

/** Safety and privacy tickets are prioritized; a linked patient never grants chart access. */
export async function createTicket(
  actor: CommandActor,
  input: z.infer<typeof ticketInput>,
  key: string,
) {
  if (input.patientId) await authorizePatient(actor, input.patientId, 'profile.read');
  return command(actor, 'self', 'support.create', key, input, async (session) => {
    const priority =
      input.category === 'SAFETY'
        ? 'URGENT'
        : input.category === 'PRIVACY' || input.category === 'PAYMENT'
          ? 'HIGH'
          : 'NORMAL';
    const hours = { URGENT: 4, HIGH: 24, NORMAL: 72 }[priority];
    const [ticket] = await SupportTicket.create(
      [
        {
          ...stamp(actor.userId),
          ...input,
          requesterUserId: actor.userId,
          priority,
          dueAt: new Date(Date.now() + hours * 3600_000),
        },
      ],
      { session },
    );
    await recordChange(
      actor,
      {
        organizationId: input.organizationId,
        patientId: input.patientId,
        action: 'SupportTicketOpened',
        resourceType: 'supportTicket',
        resourceId: String(ticket!._id),
        version: 0,
      },
      session,
    );
    return { id: String(ticket!._id), version: 0 };
  });
}

const presentTicket = (row: Record<string, unknown> & { _id: unknown }) => {
  const ticket = row as unknown as ReturnType<typeof SupportTicket.hydrate>;
  return {
    id: String(ticket._id),
    category: ticket.category,
    subject: ticket.subject,
    description: ticket.description,
    status: ticket.status,
    priority: ticket.priority,
    dueAt: ticket.dueAt,
    relatedRefs: ticket.relatedRefs,
    replies: ticket.replies.map((reply) => ({ role: reply.role, body: reply.body, at: reply.at })),
    resolution: ticket.resolution,
    version: ticket.version,
  };
};

export async function listMyTickets(actor: CommandActor, query: z.infer<typeof ticketQuery>) {
  const rows = await SupportTicket.find({
    requesterUserId: actor.userId,
    ...(query.status ? { status: query.status } : {}),
    ...before(query.before),
  })
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean();
  return pageOf(rows, query.limit, presentTicket);
}

export async function listTicketQueue(actor: CommandActor, query: z.infer<typeof ticketQuery>) {
  await requirePlatformPermission(actor, PERMISSIONS.SUPPORT_MANAGE);
  const rows = await SupportTicket.find({
    ...(query.status ? { status: query.status } : { status: { $nin: ['CLOSED'] } }),
    ...before(query.before),
  })
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean();
  return pageOf(rows, query.limit, presentTicket);
}

export async function replyToTicket(
  actor: CommandActor,
  ticketId: string,
  input: z.infer<typeof ticketReplyInput>,
  key: string,
) {
  const ticket = await SupportTicket.findById(ticketId);
  if (!ticket) throw ApiError.notFound();
  const requester = String(ticket.requesterUserId) === actor.userId;
  if (!requester) await requirePlatformPermission(actor, PERMISSIONS.SUPPORT_MANAGE);
  return command(actor, 'support', `support.reply:${ticketId}`, key, input, async (session) => {
    const current = await SupportTicket.findOne({
      _id: ticketId,
      version: input.expectedVersion,
    }).session(session);
    if (!current) conflict();
    if (current.status === 'CLOSED') conflict('The ticket is closed');
    current.replies.push({
      author: { kind: 'USER', id: actor.userId },
      role: requester ? 'REQUESTER' : 'AGENT',
      body: input.body,
      at: new Date(),
    });
    if (requester && current.status === 'WAITING')
      current.status = current.assigneeId ? 'ASSIGNED' : 'OPEN';
    current.updatedBy = { kind: 'USER', id: actor.userId };
    await current.save({ session });
    return { id: ticketId, version: current.version };
  });
}

export async function actOnTicket(
  actor: CommandActor,
  ticketId: string,
  input: z.infer<typeof ticketActionInput>,
  key: string,
) {
  await requirePlatformPermission(actor, PERMISSIONS.SUPPORT_MANAGE);
  return command(
    actor,
    'support',
    `support.${input.action}:${ticketId}`,
    key,
    input,
    async (session) => {
      const ticket = await SupportTicket.findOne({
        _id: ticketId,
        version: input.expectedVersion,
      }).session(session);
      if (!ticket) conflict();
      if (input.action === 'assign') {
        ticket.set({ status: 'ASSIGNED', assigneeId: input.assigneeId ?? actor.userId });
      } else if (input.action === 'wait') ticket.status = 'WAITING';
      else if (input.action === 'resolve') {
        if (!input.resolution) throw ApiError.badRequest('Describe the resolution');
        ticket.set({ status: 'RESOLVED', resolution: input.resolution });
      } else if (input.action === 'close') {
        if (ticket.status !== 'RESOLVED') conflict('Resolve the ticket first');
        ticket.status = 'CLOSED';
      } else {
        if (!['RESOLVED', 'CLOSED'].includes(ticket.status))
          conflict('Only resolved tickets reopen');
        ticket.status = 'OPEN';
      }
      ticket.updatedBy = { kind: 'USER', id: actor.userId };
      await ticket.save({ session });
      await recordChange(
        actor,
        {
          organizationId: ticket.organizationId ? String(ticket.organizationId) : undefined,
          action: `SupportTicket.${input.action}`,
          resourceType: 'supportTicket',
          resourceId: ticketId,
          version: ticket.version,
        },
        session,
      );
      return { id: ticketId, version: ticket.version };
    },
  );
}

// ── Reviews ──────────────────────────────────────────────────────────────────

/** Only the patient side of a completed appointment can review it, once, pending moderation. */
export async function submitReview(
  actor: CommandActor,
  input: z.infer<typeof reviewInput>,
  key: string,
) {
  const appointment = await Appointment.findById(input.appointmentId);
  if (!appointment) throw ApiError.notFound();
  await authorizePatient(actor, String(appointment.patientId), 'profile.update');
  if (appointment.status !== 'COMPLETED')
    throw new ApiError(
      409,
      'Reviews need a completed appointment',
      undefined,
      'REVIEW_NOT_ELIGIBLE',
    );
  try {
    return await command(
      actor,
      'self',
      `review:${input.appointmentId}`,
      key,
      input,
      async (session) => {
        const [review] = await Review.create(
          [
            {
              ...stamp(actor.userId),
              organizationId: appointment.organizationId,
              patientId: appointment.patientId,
              authorUserId: actor.userId,
              appointmentId: appointment._id,
              doctorId: appointment.doctorId,
              facilityId: appointment.facilityId,
              rating: input.rating,
              text: input.text,
            },
          ],
          { session },
        );
        await recordChange(
          actor,
          {
            organizationId: String(appointment.organizationId),
            action: 'ReviewSubmitted',
            resourceType: 'review',
            resourceId: String(review!._id),
            version: 0,
          },
          session,
        );
        return { id: String(review!._id), version: 0 };
      },
    );
  } catch (error) {
    if (isDuplicateKeyError(error)) conflict('You already reviewed this appointment');
    throw error;
  }
}

export async function moderationQueue(actor: CommandActor, page: Pagination) {
  await requirePlatformPermission(actor, PERMISSIONS.REVIEWS_MODERATE);
  const rows = await Review.find({ status: 'PENDING', ...before(page.before) })
    .sort({ _id: 1 })
    .limit(page.limit + 1)
    .lean();
  return pageOf(rows, page.limit, (row) => ({
    id: String(row._id),
    doctorId: String(row.doctorId),
    rating: row.rating,
    text: row.text,
    createdAt: row.createdAt,
    version: row.version,
  }));
}

export async function moderateReview(
  actor: CommandActor,
  reviewId: string,
  input: z.infer<typeof moderationInput>,
  key: string,
) {
  await requirePlatformPermission(actor, PERMISSIONS.REVIEWS_MODERATE);
  return command(actor, 'platform', `review.moderate:${reviewId}`, key, input, async (session) => {
    const review = await Review.findOne({ _id: reviewId, version: input.expectedVersion }).session(
      session,
    );
    if (!review) conflict();
    if (String(review.authorUserId) === actor.userId)
      throw ApiError.forbidden('Authors cannot moderate their own review');
    review.set({
      status: input.status,
      moderationReason: input.reason,
      moderatedBy: actor.userId,
      updatedBy: { kind: 'USER', id: actor.userId },
    });
    await review.save({ session });
    await recordChange(
      actor,
      {
        organizationId: String(review.organizationId),
        action: `Review.${input.status}`,
        resourceType: 'review',
        resourceId: reviewId,
        version: review.version,
        reason: input.reason,
      },
      session,
    );
    return { id: reviewId, version: review.version };
  });
}

export async function replyToReview(
  actor: CommandActor,
  organizationId: string,
  reviewId: string,
  input: z.infer<typeof replyInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'reviews.reply');
  return command(actor, organizationId, `review.reply:${reviewId}`, key, input, async (session) => {
    await scoped(actor, organizationId, 'reviews.reply', session);
    const review = await Review.findOne({
      _id: reviewId,
      organizationId,
      version: input.expectedVersion,
      status: 'PUBLISHED',
    }).session(session);
    if (!review) conflict();
    review.set({
      providerReply: { text: input.text, authorId: actor.userId, at: new Date() },
      updatedBy: { kind: 'USER', id: actor.userId },
    });
    await review.save({ session });
    return { id: reviewId, version: review.version };
  });
}

/** Public reviews show only rating, text, date and the provider's reply; no patient identity. */
export async function publicReviews(doctorId: string, page: Pagination) {
  const rows = await Review.find({ doctorId, status: 'PUBLISHED', ...before(page.before) })
    .sort({ _id: -1 })
    .limit(page.limit + 1)
    .lean();
  return pageOf(rows, page.limit, (row) => ({
    id: String(row._id),
    rating: row.rating,
    text: row.text,
    author: 'Verified patient',
    createdAt: row.createdAt,
    providerReply: row.providerReply
      ? { text: row.providerReply.text, at: row.providerReply.at }
      : undefined,
  }));
}
