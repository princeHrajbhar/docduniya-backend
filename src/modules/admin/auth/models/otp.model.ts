import { Schema, model } from 'mongoose';

/**
 * - `EMAIL_VERIFICATION`: 6-digit code emailed at registration.
 * - `PASSWORD_RESET`: high-entropy link token for forgot-password and admin account setup.
 */
export const OTP_PURPOSES = ['EMAIL_VERIFICATION', 'PASSWORD_RESET'] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];

export interface IOtp {
  email: string;
  purpose: OtpPurpose;
  /** bcrypt hash for numeric codes, SHA-256 for link tokens. */
  secretHash: string;
  expiresAt: Date;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
}

const otpSchema = new Schema<IOtp>(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    purpose: { type: String, enum: OTP_PURPOSES, required: true },
    secretHash: { type: String, required: true, select: false },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
  },
  { timestamps: true },
);

otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
otpSchema.index({ email: 1, purpose: 1, createdAt: -1 });

export const Otp = model<IOtp>('Otp', otpSchema);
