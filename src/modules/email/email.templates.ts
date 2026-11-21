import { env } from '../../config/env.js';
import { getBrandName } from './email.config.js';

export function escapeEmailHtml(value: string): string {
  const entities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return value.replace(/[&<>"']/g, (character) => entities[character] ?? character);
}

/** Converts email HTML to a readable plain-text alternative. */
export function stripEmailHtml(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<p[^>]*>/gi, '')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/(div|tr|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export const EMAIL_DELIVERY_HINT =
  'If the message is not in your inbox, please check the spam or junk folder.';

export const frontendUrl = (path = ''): string => new URL(path, env.FRONTEND_URL).toString();

/** Logo served from the frontend's public folder unless EMAIL_LOGO_URL is set. */
const emailLogoUrl = (): string =>
  process.env.EMAIL_LOGO_URL?.trim() || frontendUrl('/brand/email-logo.png');

export interface EmailLayoutInput {
  eyebrow: string;
  title: string;
  /** Trusted HTML. Escape every user-supplied value with `escapeEmailHtml`. */
  body: string;
  preheader?: string;
  actionLabel?: string;
  actionUrl?: string;
  footer?: string;
}

/** Responsive, dark-mode aware, table-based layout shared by every transactional email. */
export function emailLayout(input: EmailLayoutInput): string {
  const brand = escapeEmailHtml(getBrandName());
  const action =
    input.actionLabel && input.actionUrl
      ? `<tr><td align="center" style="padding:8px 32px 30px"><a href="${escapeEmailHtml(input.actionUrl)}" class="email-button" style="display:inline-block;border-radius:10px;background:#0f172a;color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:700;line-height:20px;padding:14px 24px;text-decoration:none">${escapeEmailHtml(input.actionLabel)}</a></td></tr>`
      : '';
  const preheader = escapeEmailHtml(input.preheader || input.title);
  const logo = `<img src="${escapeEmailHtml(emailLogoUrl())}" width="156" alt="${brand}" style="display:block;width:156px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none">`;
  const footer = escapeEmailHtml(
    input.footer ||
      `This message was sent by ${getBrandName()} because of activity related to your account.`,
  );

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${escapeEmailHtml(input.title)}</title>
  <style>
    @media (prefers-color-scheme: dark) {
      body,.email-bg { background:#0b1120 !important; }
      .email-card { background:#111827 !important; border-color:#334155 !important; }
      .email-title,.email-copy strong { color:#f8fafc !important; }
      .email-copy { color:#cbd5e1 !important; }
      .email-muted { color:#94a3b8 !important; }
      .email-divider { border-color:#334155 !important; }
      .email-button { background:#f8fafc !important; color:#0f172a !important; }
    }
    @media only screen and (max-width:620px) {
      .email-shell { width:100% !important; }
      .email-pad { padding-left:22px !important; padding-right:22px !important; }
    }
  </style>
</head>
<body class="email-bg" style="margin:0;padding:0;background:#f1f5f9;-webkit-text-size-adjust:100%;word-spacing:normal">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${preheader}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="email-bg" style="background:#f1f5f9">
    <tr><td align="center" style="padding:32px 12px">
      <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" class="email-shell email-card" style="width:600px;max-width:600px;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;box-shadow:0 12px 36px rgba(15,23,42,.08)">
        <tr><td style="height:5px;background:linear-gradient(90deg,#22d3ee,#2563eb,#7c3aed);font-size:0;line-height:0">&nbsp;</td></tr>
        <tr><td class="email-pad" style="padding:24px 32px;background:#ffffff;border-bottom:1px solid #e2e8f0">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
            <td>${logo}</td>
            <td align="right" style="font-family:Arial,sans-serif;font-size:10px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#64748b">${escapeEmailHtml(input.eyebrow)}</td>
          </tr></table>
        </td></tr>
        <tr><td class="email-pad" style="padding:30px 32px 10px">
          <h1 class="email-title" style="margin:0;color:#0f172a;font-family:Arial,sans-serif;font-size:28px;line-height:1.25;letter-spacing:-.025em">${escapeEmailHtml(input.title)}</h1>
        </td></tr>
        <tr><td class="email-pad email-copy" style="padding:10px 32px 24px;color:#475569;font-family:Arial,sans-serif;font-size:15px;line-height:1.72">${input.body}</td></tr>
        ${action}
        <tr><td class="email-pad" style="padding:0 32px 24px">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px"><tr><td style="padding:14px 16px;color:#64748b;font-family:Arial,sans-serif;font-size:11px;line-height:1.6">
            <strong style="color:#334155">Official ${brand} communication.</strong> We never ask you to share passwords or one-time verification codes by reply.
          </td></tr></table>
        </td></tr>
        <tr><td class="email-pad email-divider email-muted" style="border-top:1px solid #e2e8f0;padding:20px 32px 26px;color:#64748b;font-family:Arial,sans-serif;font-size:12px;line-height:1.6">
          ${footer}
          <br><br><strong>${brand}</strong> · Automated account communication
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
