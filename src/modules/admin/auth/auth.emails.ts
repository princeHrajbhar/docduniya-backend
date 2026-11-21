import { emailLayout, escapeEmailHtml, getBrandName, sendEmail } from '../../email/index.js';
import {
  ACCOUNT_SETUP_TTL_MS,
  OTP_TTL_MS,
  PASSWORD_RESET_TTL_MS,
  minutes,
} from './auth.constants.js';

/** All auth emails are `sensitive`: their bodies are never written to the delivery log. */

export function sendVerificationCodeEmail(to: string, code: string) {
  const brand = getBrandName();
  return sendEmail({
    to,
    senderPurpose: 'auth',
    sensitive: true,
    template: 'account-verification',
    subject: `Your ${brand} verification code`,
    html: emailLayout({
      eyebrow: 'Account verification',
      title: `Verify your ${brand} account`,
      preheader: `Your one-time verification code is ${code}`,
      body:
        '<p style="margin:0 0 14px">Use the one-time code below to verify your email address.</p>' +
        `<div style="margin:24px 0;text-align:center;font-size:34px;letter-spacing:8px;font-weight:800;color:#111827">${escapeEmailHtml(code)}</div>` +
        `<p style="margin:0">This code expires in ${minutes(OTP_TTL_MS)} minutes. Never share it with anyone.</p>`,
    }),
    text: `Your ${brand} verification code is ${code}. It expires in ${minutes(OTP_TTL_MS)} minutes. Never share it with anyone.`,
  });
}

export function sendPasswordResetEmail(to: string, resetUrl: string) {
  return sendEmail({
    to,
    senderPurpose: 'auth',
    sensitive: true,
    template: 'password-reset',
    subject: 'Reset your password',
    html: emailLayout({
      eyebrow: 'Password security',
      title: 'Reset your password',
      body: `<p style="margin:0">A password reset was requested for your account. Use the secure link below within ${minutes(PASSWORD_RESET_TTL_MS)} minutes. If you did not request this, you can safely ignore this message.</p>`,
      actionLabel: 'Reset password',
      actionUrl: resetUrl,
    }),
  });
}

export function sendAccountSetupEmail(input: {
  to: string;
  role: string;
  setupUrl: string;
  actorUserId?: string;
}) {
  const brand = getBrandName();
  return sendEmail({
    to: input.to,
    senderPurpose: 'auth',
    sensitive: true,
    template: 'admin-created-account',
    subject: `Your ${brand} account has been created`,
    actorUserId: input.actorUserId,
    html: emailLayout({
      eyebrow: 'Account created',
      title: `Your ${brand} account is ready`,
      body:
        `<p style="margin:0 0 14px">An administrator created an account for <strong>${escapeEmailHtml(input.to)}</strong>.</p>` +
        `<p style="margin:0 0 14px"><strong>Role:</strong> ${escapeEmailHtml(input.role)}</p>` +
        `<p style="margin:0">Create your private password using the secure, single-use setup link. ${escapeEmailHtml(brand)} never sends passwords by email.</p>`,
      actionLabel: 'Create my password',
      actionUrl: input.setupUrl,
      footer: `The setup link expires in ${Math.round(ACCOUNT_SETUP_TTL_MS / 3_600_000)} hours. Do not forward or share it.`,
    }),
  });
}
