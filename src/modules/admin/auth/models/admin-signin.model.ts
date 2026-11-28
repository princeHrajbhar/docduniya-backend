import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * Second step of an administrator sign-in: after the password, a one-time code is emailed and
 * must be entered here. The challenge token is shown to the browser once and stored hashed; the
 * code is stored as a bcrypt hash. A challenge is single use, expires, allows a limited number of
 * attempts and is closed when the same administrator starts a newer sign-in.
 */
const adminSignInSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    tokenHash: { type: String, required: true },
    codeHash: { type: String, required: true, select: false },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    /** Emails sent for this challenge (the first one plus resends). */
    sends: { type: Number, default: 1 },
    lastSentAt: { type: Date, required: true },
    consumedAt: Date,
    closedReason: { type: String, enum: ['VERIFIED', 'SUPERSEDED'] },
    userAgent: String,
    ip: String,
  },
  { timestamps: true, versionKey: false, strict: 'throw' },
);
adminSignInSchema.index({ tokenHash: 1 }, { unique: true });
adminSignInSchema.index({ userId: 1, consumedAt: 1 });
// Expired challenges are removed an hour after they lapse.
adminSignInSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });

export const AdminSignInChallenge = model(
  'AdminSignInChallenge',
  adminSignInSchema,
  'adminSignInChallenges',
);
export type AdminSignInChallengeDocument = HydratedDocument<
  InferSchemaType<typeof adminSignInSchema>
>;
