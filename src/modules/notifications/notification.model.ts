import { Schema, model } from 'mongoose';
import { actorSchema, bounded, ref } from '../../shared/persistence/schema.js';

const value = { _id: false, strict: 'throw', versionKey: false } as const;

const templateSchema = new Schema(
  {
    code: { type: String, required: true, maxlength: 60 },
    versionNumber: { type: Number, required: true, min: 1 },
    channel: { type: String, enum: ['EMAIL', 'IN_APP'], required: true },
    language: { type: String, required: true, maxlength: 10 },
    subject: { type: String, maxlength: 200 },
    body: { type: String, required: true, maxlength: 10_000 },
    allowedVariables: { type: [String], default: [], validate: bounded(50) },
    approvedBy: { type: actorSchema, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { strict: 'throw', versionKey: false, autoIndex: false, autoCreate: false },
);
templateSchema.index({ code: 1, versionNumber: 1, channel: 1, language: 1 }, { unique: true });
templateSchema.pre('save', function () {
  if (!this.isNew) throw new Error('Published templates are immutable');
});
export const NotificationTemplate = model(
  'NotificationTemplate',
  templateSchema,
  'notificationTemplates',
);

const notificationSchema = new Schema(
  {
    organizationId: ref('Organization', false),
    userId: ref('User'),
    patientId: ref('Patient', false),
    templateCode: { type: String, required: true, maxlength: 60 },
    channel: { type: String, enum: ['EMAIL', 'IN_APP'], required: true },
    source: {
      type: new Schema(
        { type: { type: String, required: true }, id: { type: String, required: true } },
        value,
      ),
      required: true,
    },
    /** Values are allowlisted per template; no clinical free text is interpolated. */
    variables: { type: Map, of: String, default: {} },
    dedupeKey: { type: String, required: true, maxlength: 300 },
    scheduledAt: { type: Date, required: true },
    status: {
      type: String,
      enum: ['PENDING', 'SENT', 'FAILED', 'SUPPRESSED', 'CANCELLED'],
      default: 'PENDING',
    },
    attempts: { type: Number, default: 0 },
    leaseUntil: Date,
    sentAt: Date,
    readAt: Date,
    providerMessageId: { type: String, maxlength: 200 },
    lastErrorCode: { type: String, maxlength: 100 },
    title: { type: String, maxlength: 200 },
    body: { type: String, maxlength: 2000 },
  },
  { timestamps: true, strict: 'throw', versionKey: false, autoIndex: false, autoCreate: false },
);
notificationSchema.index({ dedupeKey: 1 }, { unique: true });
notificationSchema.index({ status: 1, scheduledAt: 1 });
notificationSchema.index({ userId: 1, channel: 1, _id: -1 });
export const Notification = model('Notification', notificationSchema, 'notifications');

/** Consumer deduplication marker, written in the same transaction as the consumer's effect. */
const processedSchema = new Schema(
  {
    consumer: { type: String, required: true, maxlength: 60 },
    eventId: { type: String, required: true },
    processedAt: { type: Date, default: Date.now },
  },
  { strict: 'throw', versionKey: false, autoIndex: false, autoCreate: false },
);
processedSchema.index({ consumer: 1, eventId: 1 }, { unique: true });
export const ProcessedEvent = model('ProcessedEvent', processedSchema, 'processedEvents');
