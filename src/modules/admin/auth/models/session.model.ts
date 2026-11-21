import { Schema, model, type Types } from 'mongoose';

export interface ISession {
  userId: Types.ObjectId;
  /** SHA-256 of the refresh-token secret; the plaintext is never stored. */
  refreshTokenHash: string;
  userAgent?: string;
  ip?: string;
  expiresAt: Date;
  lastUsedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const sessionSchema = new Schema<ISession>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    refreshTokenHash: { type: String, required: true, select: false },
    userAgent: { type: String, maxlength: 512 },
    ip: { type: String, maxlength: 64 },
    expiresAt: { type: Date, required: true },
    lastUsedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);

// MongoDB removes expired sessions automatically.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
sessionSchema.index({ userId: 1, lastUsedAt: -1 });

export const Session = model<ISession>('Session', sessionSchema);
