import { z } from 'zod';
import { OBJECT_ID_PATTERN } from '../../../utils/mongo.js';
import { OTP_LENGTH, ROLE_SLUG_PATTERN } from './auth.constants.js';

// ── Shared field schemas (reused by the users module) ───────────────────────

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters')
  .regex(/[A-Z]/, 'Must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Must contain at least one number')
  .regex(/[^A-Za-z0-9]/, 'Must contain at least one special character');

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Invalid email format')
  .max(254, 'Email too long');

export const roleSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(80)
  .regex(ROLE_SLUG_PATTERN, 'Invalid role slug');

export const objectIdSchema = z.string().regex(OBJECT_ID_PATTERN, 'Invalid id');

const otpSchema = z
  .string()
  .trim()
  .length(OTP_LENGTH, `Code must be exactly ${OTP_LENGTH} digits`)
  .regex(/^\d+$/, 'Code must be numeric');

const resetTokenSchema = z
  .string()
  .trim()
  .regex(/^[a-f0-9]{64}$/i, 'Invalid reset token');

// ── Request schemas ─────────────────────────────────────────────────────────

export const registerSchema = z.object({ email: emailSchema, password: passwordSchema }).strict();

export const verifyOtpSchema = z.object({ email: emailSchema, otp: otpSchema }).strict();

export const resendOtpSchema = z
  .object({
    email: emailSchema,
    type: z.enum(['REGISTER', 'RESET_PASSWORD']).default('REGISTER'),
  })
  .strict();

export const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1, 'Password cannot be empty').max(128),
  })
  .strict();

export const googleAuthSchema = z
  .object({ credential: z.string().trim().min(100, 'Google credential is required').max(10_000) })
  .strict();

export const forgotPasswordSchema = z.object({ email: emailSchema }).strict();

// Preferred: { token, email, newPassword }. `resetUrl` is accepted for clients that post the full link.
export const resetPasswordSchema = z.union([
  z.object({ token: resetTokenSchema, email: emailSchema, newPassword: passwordSchema }).strict(),
  z.object({ resetUrl: z.url('Reset URL must be valid'), newPassword: passwordSchema }).strict(),
]);

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required').max(128),
    newPassword: passwordSchema,
    confirmPassword: z.string(),
  })
  .strict()
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })
  .refine((data) => data.currentPassword !== data.newPassword, {
    message: 'New password must differ from current password',
    path: ['newPassword'],
  });

export const sessionIdParamsSchema = z.object({ sessionId: objectIdSchema });

export type RegisterInput = z.infer<typeof registerSchema>;
export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>;
export type ResendOtpInput = z.infer<typeof resendOtpSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const mfaCodeSchema = z.strictObject({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/u),
});
export const mfaVerifySchema = z
  .strictObject({
    challengeToken: z.string().min(20).max(200),
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/u)
      .optional(),
    recoveryCode: z.string().trim().min(10).max(20).optional(),
  })
  .refine((value) => Boolean(value.code) !== Boolean(value.recoveryCode), {
    message: 'Provide either an authenticator code or a recovery code',
  });

// ── Administrator portal ────────────────────────────────────────────────────

const challengeTokenSchema = z.string().trim().min(20).max(200);
export const adminLoginSchema = loginSchema;
export const adminVerifySchema = z.strictObject({
  challengeToken: challengeTokenSchema,
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/u, 'Enter the 6-digit code from the email'),
});
export const adminResendSchema = z.strictObject({ challengeToken: challengeTokenSchema });
