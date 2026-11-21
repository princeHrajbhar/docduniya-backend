import { emailLayout, escapeEmailHtml, getBrandName, sendEmail } from '../email/index.js';

export function sendAccountUpdatedEmail(input: {
  to: string;
  email: string;
  previousEmail?: string;
  role: string;
  changedFields: string[];
  passwordChanged: boolean;
  actorUserId: string;
}) {
  const brand = getBrandName();
  const emailLines =
    input.previousEmail && input.previousEmail !== input.email
      ? `<p style="margin:0 0 10px"><strong>Previous email:</strong> ${escapeEmailHtml(input.previousEmail)}</p>` +
        `<p style="margin:0 0 10px"><strong>Current email:</strong> ${escapeEmailHtml(input.email)}</p>`
      : `<p style="margin:0 0 10px"><strong>Account email:</strong> ${escapeEmailHtml(input.email)}</p>`;
  const closing = input.passwordChanged
    ? '<p style="margin:14px 0 0">Your password was changed and existing sessions were signed out.</p>'
    : `<p style="margin:14px 0 0">If you did not expect this change, contact the ${escapeEmailHtml(brand)} administrator immediately.</p>`;

  return sendEmail({
    to: input.to,
    senderPurpose: 'auth',
    template: 'account-updated',
    subject: `Your ${brand} account was updated`,
    actorUserId: input.actorUserId,
    html: emailLayout({
      eyebrow: 'Security notification',
      title: `Your ${brand} account was updated`,
      body:
        `<p style="margin:0 0 14px">An administrator updated your ${escapeEmailHtml(brand)} account.</p>` +
        emailLines +
        `<p style="margin:0 0 10px"><strong>Current role:</strong> ${escapeEmailHtml(input.role)}</p>` +
        `<p style="margin:0 0 10px"><strong>Updated fields:</strong> ${escapeEmailHtml(input.changedFields.join(', '))}</p>` +
        closing,
      footer: 'This is an automated account security notification.',
    }),
  });
}
