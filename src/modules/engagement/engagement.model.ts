import { Schema, model } from 'mongoose';
import {
  actorSchema,
  aggregateOptions,
  bounded,
  metadataFields,
  ref,
} from '../../shared/persistence/schema.js';

const value = { _id: false, strict: 'throw', versionKey: false } as const;

const ticketSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization', false),
    requesterUserId: ref('User'),
    patientId: ref('Patient', false),
    category: {
      type: String,
      enum: ['BOOKING', 'PROVIDER', 'PAYMENT', 'PRIVACY', 'SAFETY', 'TECHNICAL'],
      required: true,
    },
    subject: { type: String, required: true, maxlength: 200 },
    description: { type: String, required: true, maxlength: 4000 },
    relatedRefs: {
      type: [
        new Schema(
          {
            type: {
              type: String,
              enum: ['appointment', 'invoice', 'payment', 'refund', 'document'],
              required: true,
            },
            id: { type: Schema.Types.ObjectId, required: true },
          },
          value,
        ),
      ],
      default: [],
      validate: bounded(20),
    },
    status: {
      type: String,
      enum: ['OPEN', 'ASSIGNED', 'WAITING', 'RESOLVED', 'CLOSED'],
      default: 'OPEN',
    },
    priority: { type: String, enum: ['NORMAL', 'HIGH', 'URGENT'], default: 'NORMAL' },
    assigneeId: ref('User', false),
    dueAt: Date,
    replies: {
      type: [
        new Schema(
          {
            author: { type: actorSchema, required: true },
            role: { type: String, enum: ['REQUESTER', 'AGENT'], required: true },
            body: { type: String, required: true, maxlength: 4000 },
            at: { type: Date, required: true },
          },
          value,
        ),
      ],
      default: [],
      validate: bounded(200),
    },
    resolution: { type: String, maxlength: 2000 },
  },
  aggregateOptions,
);
ticketSchema.index({ organizationId: 1, status: 1, createdAt: -1 });
ticketSchema.index({ assigneeId: 1, status: 1 });
ticketSchema.index({ requesterUserId: 1, _id: -1 });
ticketSchema.index({ status: 1, dueAt: 1 });
export const SupportTicket = model('SupportTicket', ticketSchema, 'supportTickets');

const reviewSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    patientId: ref('Patient'),
    authorUserId: ref('User'),
    appointmentId: ref('Appointment'),
    doctorId: ref('Doctor'),
    facilityId: ref('Facility'),
    rating: { type: Number, required: true, min: 1, max: 5, validate: Number.isInteger },
    text: { type: String, maxlength: 2000 },
    status: {
      type: String,
      enum: ['PENDING', 'PUBLISHED', 'HIDDEN', 'REMOVED'],
      default: 'PENDING',
    },
    moderationReason: { type: String, maxlength: 1000 },
    moderatedBy: ref('User', false),
    providerReply: {
      type: new Schema(
        {
          text: { type: String, required: true, maxlength: 2000 },
          authorId: ref('User'),
          at: { type: Date, required: true },
        },
        value,
      ),
    },
  },
  aggregateOptions,
);
reviewSchema.index({ organizationId: 1, appointmentId: 1, authorUserId: 1 }, { unique: true });
reviewSchema.index({ doctorId: 1, status: 1, createdAt: -1 });
reviewSchema.index({ status: 1, createdAt: 1 });
export const Review = model('Review', reviewSchema, 'reviews');
