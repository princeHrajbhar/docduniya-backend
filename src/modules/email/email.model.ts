import { Schema, model, type Types } from 'mongoose';
import { EMAIL_SENDER_PURPOSES, type EmailSenderPurpose } from './email.types.js';

// ── Suppression list: addresses that must never receive email ───────────────

export interface IEmailSuppression {
  email: string;
  reason?: string;
  blockedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const emailSuppressionSchema = new Schema<IEmailSuppression>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    reason: { type: String, trim: true, maxlength: 500 },
    blockedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export const EmailSuppression = model<IEmailSuppression>(
  'EmailSuppression',
  emailSuppressionSchema,
);

// ── Delivery log: one record per send attempt ───────────────────────────────

export const EMAIL_DELIVERY_STATUSES = ['sent', 'failed', 'blocked'] as const;
export type EmailDeliveryStatus = (typeof EMAIL_DELIVERY_STATUSES)[number];

export interface IEmailLog {
  to: string;
  subject: string;
  status: EmailDeliveryStatus;
  template?: string;
  senderEmail?: string;
  senderPurpose?: EmailSenderPurpose;
  providerMessageId?: string;
  error?: string;
  /** Omitted for sensitive messages (OTP codes, reset links). */
  bodyText?: string;
  sensitive: boolean;
  actorUserId?: Types.ObjectId;
  linkedUserId?: Types.ObjectId;
  relatedType?: string;
  relatedId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const emailLogSchema = new Schema<IEmailLog>(
  {
    to: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
    subject: { type: String, required: true, trim: true, maxlength: 240 },
    status: { type: String, enum: EMAIL_DELIVERY_STATUSES, required: true },
    template: { type: String, trim: true, maxlength: 160 },
    senderEmail: { type: String, trim: true, lowercase: true, maxlength: 320 },
    senderPurpose: { type: String, enum: EMAIL_SENDER_PURPOSES },
    providerMessageId: { type: String, trim: true, maxlength: 500 },
    error: { type: String, trim: true, maxlength: 1000 },
    bodyText: { type: String, maxlength: 100_000 },
    sensitive: { type: Boolean, default: false },
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    linkedUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    relatedType: { type: String, trim: true, maxlength: 80 },
    relatedId: { type: String, trim: true, maxlength: 120 },
  },
  { timestamps: true },
);

emailLogSchema.index({ to: 1, createdAt: -1 });
emailLogSchema.index({ status: 1, createdAt: -1 });
emailLogSchema.index({ createdAt: -1 });

export const EmailLog = model<IEmailLog>('EmailLog', emailLogSchema);
