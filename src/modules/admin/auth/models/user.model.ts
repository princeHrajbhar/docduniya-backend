import { Schema, model, type HydratedDocument } from 'mongoose';
import { DEFAULT_USER_ROLE, ROLE_SLUG_PATTERN } from '../auth.constants.js';

export interface IUser {
  email: string;
  /** bcrypt hash. Never selected unless explicitly requested. */
  password?: string;
  /** Stable Google account identifier (OIDC `sub`), never the email address. */
  googleSub?: string;
  isVerified: boolean;
  /** Disabled accounts cannot sign in or refresh sessions. */
  isActive: boolean;
  /** Slug of an AccessRole. */
  role: string;
  mustChangePassword: boolean;
  failedLoginAttempts: number;
  lockedUntil?: Date;
  lastFailedLoginAt?: Date;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type UserDocument = HydratedDocument<IUser>;

const userSchema = new Schema<IUser>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    password: { type: String, select: false },
    googleSub: { type: String, unique: true, sparse: true, trim: true, select: false },
    isVerified: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true, index: true },
    role: {
      type: String,
      default: DEFAULT_USER_ROLE,
      lowercase: true,
      trim: true,
      maxlength: 80,
      match: ROLE_SLUG_PATTERN,
      index: true,
    },
    mustChangePassword: { type: Boolean, default: false },
    failedLoginAttempts: { type: Number, default: 0 },
    lockedUntil: Date,
    lastFailedLoginAt: Date,
    lastLoginAt: Date,
  },
  { timestamps: true },
);

userSchema.index({ createdAt: -1, _id: -1 });

export const User = model<IUser>('User', userSchema);
