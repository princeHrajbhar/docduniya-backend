import { Schema, model } from 'mongoose';
import { actorSchema, aggregateOptions } from '../../shared/persistence/schema.js';

const auditSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization' },
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient' },
    actor: { type: actorSchema, required: true },
    action: { type: String, required: true },
    resourceType: { type: String, required: true },
    resourceId: { type: Schema.Types.ObjectId, required: true },
    outcome: { type: String, enum: ['SUCCESS', 'ALLOW', 'DENY'], required: true },
    occurredAt: { type: Date, required: true, default: Date.now },
    requestId: { type: String, required: true },
    reason: { type: String, maxlength: 4000 },
    schemaVersion: { type: Number, default: 1 },
  },
  { strict: 'throw', versionKey: false, autoIndex: false, autoCreate: false },
);
auditSchema.index({ organizationId: 1, occurredAt: -1, _id: -1 });
auditSchema.index({ patientId: 1, occurredAt: -1 });
auditSchema.pre('save', function () {
  if (!this.isNew) throw new Error('Audit records are append-only');
});
auditSchema.pre('deleteOne', { document: true, query: false }, function () {
  throw new Error('Audit records are append-only');
});
auditSchema.pre(
  [
    'updateOne',
    'updateMany',
    'findOneAndUpdate',
    'replaceOne',
    'findOneAndReplace',
    'deleteOne',
    'deleteMany',
    'findOneAndDelete',
  ],
  function () {
    throw new Error('Audit records are append-only');
  },
);
export const AuditEvent = model('AuditEvent', auditSchema, 'auditEvents');

const outboxSchema = new Schema(
  {
    eventId: { type: String, required: true },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization' },
    type: { type: String, required: true },
    aggregateType: { type: String, required: true },
    aggregateId: { type: Schema.Types.ObjectId, required: true },
    aggregateVersion: { type: Number, required: true },
    actor: { type: actorSchema, required: true },
    correlationId: { type: String, required: true },
    eventSchemaVersion: { type: Number, default: 1 },
    occurredAt: { type: Date, required: true, default: Date.now },
    state: { type: String, enum: ['PENDING', 'LEASED', 'PUBLISHED', 'FAILED'], default: 'PENDING' },
    availableAt: { type: Date, default: Date.now },
    leaseToken: String,
    leaseUntil: Date,
    attempts: { type: Number, default: 0 },
    publishedAt: Date,
  },
  aggregateOptions,
);
outboxSchema.index({ eventId: 1 }, { unique: true });
outboxSchema.index({ state: 1, availableAt: 1 });
outboxSchema.index({ state: 1, leaseUntil: 1 });
export const OutboxEvent = model('OutboxEvent', outboxSchema, 'outboxEvents');

const keySchema = new Schema(
  {
    scopeKey: { type: String, required: true },
    actorId: { type: String, required: true },
    operation: { type: String, required: true },
    key: { type: String, required: true },
    requestHash: { type: String, required: true },
    result: {
      type: new Schema(
        { id: { type: String, required: true }, version: { type: Number, required: true } },
        { _id: false, strict: 'throw', versionKey: false },
      ),
      required: true,
    },
  },
  { timestamps: true, strict: 'throw', versionKey: false, autoIndex: false, autoCreate: false },
);
keySchema.index({ scopeKey: 1, actorId: 1, operation: 1, key: 1 }, { unique: true });
export const IdempotencyKey = model('IdempotencyKey', keySchema, 'idempotencyKeys');

const sequenceSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    kind: { type: String, required: true },
    nextValue: { type: Number, default: 0 },
  },
  { strict: 'throw', versionKey: false, autoIndex: false, autoCreate: false },
);
sequenceSchema.index({ organizationId: 1, kind: 1 }, { unique: true });
export const NumberSequence = model('NumberSequence', sequenceSchema, 'numberSequences');
