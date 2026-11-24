import { Schema, Types } from 'mongoose';

export const actorSchema = new Schema(
  {
    kind: { type: String, enum: ['USER', 'SERVICE'], required: true },
    id: { type: String, required: true, maxlength: 100 },
  },
  { _id: false, strict: 'throw', versionKey: false },
);

export const metadataFields = {
  createdBy: { type: actorSchema, required: true },
  updatedBy: { type: actorSchema, required: true },
  schemaVersion: { type: Number, required: true, default: 1, min: 1 },
  version: { type: Number, required: true, default: 0, min: 0 },
} as const;
export const aggregateOptions = {
  timestamps: true,
  strict: 'throw',
  versionKey: 'version',
  optimisticConcurrency: true,
  autoIndex: false,
  autoCreate: false,
} as const;
export const nameSchema = new Schema(
  {
    display: { type: String, required: true, maxlength: 200 },
    given: String,
    middle: String,
    family: String,
    prefix: String,
    native: String,
  },
  { _id: false, strict: 'throw', versionKey: false },
);
export const addressSchema = new Schema(
  {
    id: { type: Schema.Types.ObjectId, default: () => new Types.ObjectId() },
    use: { type: String, enum: ['HOME', 'WORK', 'MAILING', 'TEMPORARY'], required: true },
    line1: { type: String, required: true, maxlength: 200 },
    line2: String,
    locality: String,
    city: { type: String, required: true },
    district: String,
    stateCode: { type: String, required: true },
    postalCode: { type: String, required: true, match: /^\d{6}$/ },
    countryCode: { type: String, enum: ['IN'], required: true },
  },
  { _id: false, strict: 'throw', versionKey: false },
);
export const contactSchema = new Schema(
  {
    kind: { type: String, enum: ['PHONE', 'EMAIL'], required: true },
    value: { type: String, required: true },
    normalized: { type: String, required: true },
    use: { type: String, enum: ['PERSONAL', 'WORK', 'EMERGENCY'], required: true },
    verifiedAt: Date,
  },
  { _id: false, strict: 'throw', versionKey: false },
);

export const ref = <R extends boolean = true>(name: string, required: R = true as R) => ({
  type: Schema.Types.ObjectId,
  ref: name,
  required,
});
export const bounded = (max: number) => ({
  validator: (v: unknown[]) => v.length <= max,
  message: `At most ${max} entries are allowed`,
});
export const stamp = (userId: string) => ({
  createdBy: { kind: 'USER' as const, id: userId },
  updatedBy: { kind: 'USER' as const, id: userId },
});
