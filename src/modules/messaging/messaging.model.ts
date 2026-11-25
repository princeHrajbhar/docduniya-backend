import { Schema, model } from 'mongoose';
import { aggregateOptions, bounded, metadataFields, ref } from '../../shared/persistence/schema.js';

/**
 * Secure conversation between a patient and a provider. CARE threads carry health information
 * and are visible only to the patient side and the treating clinicians; ADMINISTRATIVE threads
 * (billing, scheduling) are handled by the front desk.
 */
const conversationSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    facilityId: ref('Facility'),
    patientId: ref('Patient'),
    appointmentId: ref('Appointment', false),
    kind: { type: String, enum: ['CARE', 'ADMINISTRATIVE'], required: true },
    subject: { type: String, required: true, maxlength: 200 },
    status: { type: String, enum: ['OPEN', 'CLOSED'], default: 'OPEN' },
    openedBySide: { type: String, enum: ['PATIENT', 'PROVIDER'], required: true },
    messageCount: { type: Number, default: 0, max: 500 },
    lastMessageAt: Date,
    lastMessageSide: { type: String, enum: ['PATIENT', 'PROVIDER'] },
    patientLastReadAt: Date,
    providerLastReadAt: Date,
    closedAt: Date,
  },
  aggregateOptions,
);
conversationSchema.index({ organizationId: 1, kind: 1, status: 1, lastMessageAt: -1 });
conversationSchema.index({ patientId: 1, lastMessageAt: -1 });
export const Conversation = model('Conversation', conversationSchema, 'conversations');

/** Messages are append-only; a mistaken message is followed by a correction, never edited. */
const messageSchema = new Schema(
  {
    conversationId: ref('Conversation'),
    organizationId: ref('Organization'),
    patientId: ref('Patient'),
    sequence: { type: Number, required: true, min: 1 },
    senderSide: { type: String, enum: ['PATIENT', 'PROVIDER'], required: true },
    senderUserId: ref('User'),
    body: { type: String, required: true, maxlength: 4000 },
    documentIds: { type: [Schema.Types.ObjectId], default: [], validate: bounded(5) },
    requestId: { type: String, maxlength: 100 },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    strict: 'throw',
    versionKey: false,
    autoIndex: false,
    autoCreate: false,
  },
);
messageSchema.index({ conversationId: 1, sequence: 1 }, { unique: true });
messageSchema.pre('save', function () {
  if (!this.isNew) throw new Error('Messages are append-only');
});
export const ConversationMessage = model(
  'ConversationMessage',
  messageSchema,
  'conversationMessages',
);
