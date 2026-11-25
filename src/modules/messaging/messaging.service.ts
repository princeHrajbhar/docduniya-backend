import type { ClientSession } from 'mongoose';
import { z } from 'zod';
import type { CommandActor } from '../../shared/domain/healthcare.js';
import { objectId } from '../../shared/domain/healthcare.js';
import { command, conflict } from '../../shared/application/command.js';
import { before, facilityFilter, scoped } from '../../shared/application/scope.js';
import { stamp } from '../../shared/persistence/schema.js';
import { ApiError } from '../../utils/api-error.js';
import { authorizeOrganization } from '../access/access.service.js';
import { authorizePatient } from '../patients/patient.service.js';
import { PatientRegistration } from '../patients/patient.model.js';
import { Practitioner } from '../practitioners/practitioner.model.js';
import { recordChange, recordRead } from '../operations/operation.service.js';
import { Appointment } from '../appointments/appointment.model.js';
import { CareTeamAssignment } from '../clinical/clinical.model.js';
import { authorizeClinical } from '../clinical/clinical.policy.js';
import { ClinicalDocument } from '../documents/document.model.js';
import { Conversation, ConversationMessage } from './messaging.model.js';

const MAX_MESSAGES = 500;
const body = z.string().trim().min(1).max(4000);
export const conversationInput = z.strictObject({
  organizationId: objectId,
  kind: z.enum(['CARE', 'ADMINISTRATIVE']),
  subject: z.string().trim().min(3).max(200),
  appointmentId: objectId.optional(),
  body,
  documentIds: z.array(objectId).max(5).default([]),
});
export const providerConversationInput = conversationInput
  .omit({ organizationId: true })
  .extend({ patientId: objectId });
export const messageInput = z.strictObject({
  body,
  documentIds: z.array(objectId).max(5).default([]),
});
export const conversationQuery = z.strictObject({
  kind: z.enum(['CARE', 'ADMINISTRATIVE']),
  status: z.enum(['OPEN', 'CLOSED']).default('OPEN'),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  before: objectId.optional(),
});

type Side = 'PATIENT' | 'PROVIDER';
type ConversationRow = ReturnType<typeof Conversation.hydrate>;

/** Patient-side authority: medical authority for care threads, demographic for admin threads. */
const patientAction = (kind: string, write: boolean) =>
  kind === 'CARE'
    ? write
      ? 'medical.upload'
      : 'medical.read'
    : write
      ? 'profile.update'
      : 'profile.read';

/**
 * Provider-side authority. CARE threads: the appointment's clinician or the patient's care team
 * (clinical permission + care relationship). ADMINISTRATIVE threads: the front desk.
 */
async function authorizeProviderSide(
  actor: CommandActor,
  conversation: Pick<
    ConversationRow,
    'organizationId' | 'facilityId' | 'patientId' | 'kind' | 'appointmentId'
  >,
  write: boolean,
  session?: ClientSession,
) {
  const organizationId = String(conversation.organizationId);
  const facilityId = String(conversation.facilityId);
  if (conversation.kind === 'ADMINISTRATIVE') {
    if (write && session)
      await scoped(actor, organizationId, 'appointments.manage', session, { facilityId });
    else await authorizeOrganization(actor, organizationId, 'appointments.manage', { facilityId });
    return;
  }
  const permission = write ? 'clinical.write' : 'clinical.read';
  if (conversation.appointmentId) {
    const appointment = await Appointment.findById(conversation.appointmentId)
      .session(session ?? null)
      .lean();
    const practitioner = await Practitioner.findOne({ userId: actor.userId, status: 'ACTIVE' })
      .session(session ?? null)
      .lean();
    if (
      appointment &&
      practitioner &&
      String(appointment.practitionerId) === String(practitioner._id)
    ) {
      await authorizeOrganization(actor, organizationId, permission, {
        facilityId,
        session,
        activeProvider: true,
      });
      return;
    }
  }
  await authorizeClinical(actor, organizationId, String(conversation.patientId), permission, {
    session,
    facilityId,
  });
}

async function validAttachments(patientId: string, ids: string[], session: ClientSession) {
  if (!ids.length) return;
  const count = await ClinicalDocument.countDocuments({
    _id: { $in: ids },
    status: 'AVAILABLE',
    $or: [{ subjectPatientId: patientId }, { 'custody.patientId': patientId }],
  }).session(session);
  if (count !== new Set(ids).size)
    throw ApiError.badRequest('Attach only available documents of this patient');
}

async function append(
  actor: CommandActor,
  conversation: ConversationRow,
  side: Side,
  input: { body: string; documentIds: string[] },
  session: ClientSession,
) {
  if (conversation.status !== 'OPEN') conflict('This conversation is closed');
  if (conversation.messageCount >= MAX_MESSAGES)
    conflict('This conversation is full; start a new one');
  await validAttachments(String(conversation.patientId), input.documentIds, session);
  const sequence = conversation.messageCount + 1;
  await ConversationMessage.create(
    [
      {
        conversationId: conversation._id,
        organizationId: conversation.organizationId,
        patientId: conversation.patientId,
        sequence,
        senderSide: side,
        senderUserId: actor.userId,
        body: input.body,
        documentIds: input.documentIds,
        requestId: actor.requestId,
      },
    ],
    { session },
  );
  const now = new Date();
  conversation.set({
    messageCount: sequence,
    lastMessageAt: now,
    lastMessageSide: side,
    [side === 'PATIENT' ? 'patientLastReadAt' : 'providerLastReadAt']: now,
    updatedBy: { kind: 'USER', id: actor.userId },
  });
  await conversation.save({ session });
  await recordChange(
    actor,
    {
      organizationId: String(conversation.organizationId),
      patientId: String(conversation.patientId),
      action: side === 'PROVIDER' ? 'ProviderMessagePosted' : 'PatientMessagePosted',
      resourceType: 'conversation',
      resourceId: String(conversation._id),
      version: conversation.version,
    },
    session,
  );
}

async function openConversation(
  actor: CommandActor,
  side: Side,
  input: {
    organizationId: string;
    patientId: string;
    kind: 'CARE' | 'ADMINISTRATIVE';
    subject: string;
    appointmentId?: string;
    body: string;
    documentIds: string[];
  },
  session: ClientSession,
) {
  const registration = await PatientRegistration.findOne({
    organizationId: input.organizationId,
    patientId: input.patientId,
    status: 'ACTIVE',
  }).session(session);
  if (!registration) throw ApiError.notFound('Messaging is available with your providers only');
  let facilityId = String(registration.primaryFacilityId);
  if (input.appointmentId) {
    const appointment = await Appointment.findOne({
      _id: input.appointmentId,
      organizationId: input.organizationId,
      patientId: input.patientId,
    }).session(session);
    if (!appointment) throw ApiError.notFound('Appointment is unavailable');
    facilityId = String(appointment.facilityId);
  }
  const draft = {
    organizationId: registration.organizationId,
    facilityId,
    patientId: registration.patientId,
    kind: input.kind,
    appointmentId: input.appointmentId,
  };
  if (side === 'PROVIDER') await authorizeProviderSide(actor, draft as never, true, session);
  const [conversation] = await Conversation.create(
    [
      {
        ...stamp(actor.userId),
        ...draft,
        subject: input.subject,
        openedBySide: side,
      },
    ],
    { session },
  );
  await append(actor, conversation!, side, input, session);
  return { id: String(conversation!._id), version: conversation!.version };
}

// ── Patient side ─────────────────────────────────────────────────────────────

export async function patientStartConversation(
  actor: CommandActor,
  patientId: string,
  input: z.infer<typeof conversationInput>,
  key: string,
) {
  await authorizePatient(actor, patientId, patientAction(input.kind, true));
  return command(actor, 'self', `conversation.start:${patientId}`, key, input, async (session) => {
    await authorizePatient(actor, patientId, patientAction(input.kind, true), session, true);
    return openConversation(actor, 'PATIENT', { ...input, patientId }, session);
  });
}

async function patientConversation(
  actor: CommandActor,
  conversationId: string,
  write: boolean,
  session?: ClientSession,
) {
  const conversation = await Conversation.findById(conversationId).session(session ?? null);
  if (!conversation) throw ApiError.notFound();
  await authorizePatient(
    actor,
    String(conversation.patientId),
    patientAction(conversation.kind, write),
    session,
    write,
  );
  return conversation;
}

export async function patientConversations(actor: CommandActor, patientId: string) {
  await authorizePatient(actor, patientId, 'profile.read');
  let medical = true;
  try {
    await authorizePatient(actor, patientId, 'medical.read');
  } catch {
    medical = false;
  }
  const rows = await Conversation.find({
    patientId,
    ...(medical ? {} : { kind: 'ADMINISTRATIVE' }),
  })
    .sort({ lastMessageAt: -1 })
    .limit(50);
  return { items: rows.map((row) => present(row, 'PATIENT')) };
}

export async function patientPost(
  actor: CommandActor,
  conversationId: string,
  input: z.infer<typeof messageInput>,
  key: string,
) {
  await patientConversation(actor, conversationId, false);
  return command(
    actor,
    'self',
    `conversation.post:${conversationId}`,
    key,
    input,
    async (session) => {
      const conversation = await patientConversation(actor, conversationId, true, session);
      await append(actor, conversation, 'PATIENT', input, session);
      return { id: conversationId, version: conversation.version };
    },
  );
}

export async function patientMessages(actor: CommandActor, conversationId: string) {
  const conversation = await patientConversation(actor, conversationId, false);
  return readThread(conversation, 'PATIENT');
}

// ── Provider side ────────────────────────────────────────────────────────────

export async function providerStartConversation(
  actor: CommandActor,
  organizationId: string,
  input: z.infer<typeof providerConversationInput>,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `conversation.start:${input.patientId}`,
    key,
    input,
    async (session) => openConversation(actor, 'PROVIDER', { ...input, organizationId }, session),
  );
}

async function providerConversation(
  actor: CommandActor,
  organizationId: string,
  conversationId: string,
  write: boolean,
  session?: ClientSession,
) {
  const conversation = await Conversation.findOne({ _id: conversationId, organizationId }).session(
    session ?? null,
  );
  if (!conversation) throw ApiError.notFound();
  await authorizeProviderSide(actor, conversation, write, session);
  return conversation;
}

export async function providerPost(
  actor: CommandActor,
  organizationId: string,
  conversationId: string,
  input: z.infer<typeof messageInput>,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `conversation.post:${conversationId}`,
    key,
    input,
    async (session) => {
      const conversation = await providerConversation(
        actor,
        organizationId,
        conversationId,
        true,
        session,
      );
      await append(actor, conversation, 'PROVIDER', input, session);
      return { id: conversationId, version: conversation.version };
    },
  );
}

export async function providerMessages(
  actor: CommandActor,
  organizationId: string,
  conversationId: string,
) {
  const conversation = await providerConversation(actor, organizationId, conversationId, false);
  if (conversation.kind === 'CARE')
    await recordRead(
      actor,
      'conversation',
      conversationId,
      organizationId,
      String(conversation.patientId),
    );
  return readThread(conversation, 'PROVIDER');
}

export async function closeConversation(
  actor: CommandActor,
  organizationId: string,
  conversationId: string,
  expectedVersion: number,
  key: string,
) {
  return command(
    actor,
    organizationId,
    `conversation.close:${conversationId}`,
    key,
    { expectedVersion },
    async (session) => {
      const conversation = await providerConversation(
        actor,
        organizationId,
        conversationId,
        true,
        session,
      );
      if (conversation.version !== expectedVersion || conversation.status !== 'OPEN') conflict();
      conversation.status = 'CLOSED';
      conversation.closedAt = new Date();
      conversation.updatedBy = { kind: 'USER', id: actor.userId };
      await conversation.save({ session });
      return { id: conversationId, version: conversation.version };
    },
  );
}

/**
 * Inbox: administrative threads for the front desk at the member's facilities; care threads only
 * for patients on the member's own care team.
 */
export async function providerInbox(
  actor: CommandActor,
  organizationId: string,
  query: z.infer<typeof conversationQuery>,
) {
  const permission = query.kind === 'CARE' ? 'clinical.read' : 'appointments.manage';
  const scope = await authorizeOrganization(actor, organizationId, permission, {
    activeProvider: true,
  });
  let patientFilter = {};
  if (query.kind === 'CARE') {
    const care = await CareTeamAssignment.find({
      organizationId,
      userId: actor.userId,
      status: 'ACTIVE',
    })
      .select({ patientId: 1 })
      .lean();
    patientFilter = { patientId: { $in: care.map((row) => row.patientId) } };
  }
  const rows = await Conversation.find({
    organizationId,
    kind: query.kind,
    status: query.status,
    ...facilityFilter(scope.membership),
    ...patientFilter,
    ...before(query.before),
  })
    .sort({ _id: -1 })
    .limit(query.limit + 1);
  return {
    items: rows.slice(0, query.limit).map((row) => present(row, 'PROVIDER')),
    nextCursor: rows.length > query.limit ? String(rows[query.limit - 1]!._id) : undefined,
  };
}

function present(row: ConversationRow, side: Side) {
  const lastRead = side === 'PATIENT' ? row.patientLastReadAt : row.providerLastReadAt;
  return {
    id: String(row._id),
    organizationId: String(row.organizationId),
    patientId: String(row.patientId),
    appointmentId: row.appointmentId ? String(row.appointmentId) : undefined,
    kind: row.kind,
    subject: row.subject,
    status: row.status,
    messageCount: row.messageCount,
    lastMessageAt: row.lastMessageAt,
    unread: Boolean(
      row.lastMessageAt &&
      row.lastMessageSide !== side &&
      (!lastRead || lastRead < row.lastMessageAt),
    ),
    version: row.version,
  };
}

async function readThread(conversation: ConversationRow, side: Side) {
  const messages = await ConversationMessage.find({ conversationId: conversation._id })
    .sort({ sequence: 1 })
    .limit(MAX_MESSAGES)
    .lean();
  await Conversation.updateOne(
    { _id: conversation._id },
    { $set: { [side === 'PATIENT' ? 'patientLastReadAt' : 'providerLastReadAt']: new Date() } },
  );
  return {
    conversation: present(conversation, side),
    // Staff identities are not disclosed to patients; the side is.
    messages: messages.map((message) => ({
      sequence: message.sequence,
      side: message.senderSide,
      mine: side === message.senderSide,
      body: message.body,
      documentIds: message.documentIds.map(String),
      sentAt: message.createdAt,
    })),
  };
}
