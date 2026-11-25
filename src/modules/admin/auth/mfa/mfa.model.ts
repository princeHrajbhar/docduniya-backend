import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

/** One TOTP factor per user. The secret is sealed with AES-256-GCM; codes are never stored. */
const factorSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: ['TOTP'], default: 'TOTP' },
    sealedSecret: { type: String, required: true, select: false },
    status: { type: String, enum: ['PENDING', 'ACTIVE'], default: 'PENDING' },
    /** Last accepted TOTP step: the same code cannot be replayed within its window. */
    lastUsedStep: { type: Number, default: 0 },
    recoveryCodeHashes: { type: [String], default: [], select: false },
    activatedAt: Date,
    lastVerifiedAt: Date,
  },
  { timestamps: true, versionKey: false, strict: 'throw' },
);
factorSchema.index({ userId: 1 }, { unique: true });
export const MfaFactor = model('MfaFactor', factorSchema, 'mfaFactors');
export type MfaFactorDocument = HydratedDocument<InferSchemaType<typeof factorSchema>>;

/** Second step of a password or Google sign-in; the token is shown once and stored hashed. */
const challengeSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    consumedAt: Date,
    userAgent: String,
    ip: String,
  },
  { timestamps: true, versionKey: false, strict: 'throw' },
);
challengeSchema.index({ tokenHash: 1 }, { unique: true });
challengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });
export const MfaChallenge = model('MfaChallenge', challengeSchema, 'mfaChallenges');
