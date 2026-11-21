import type {
  EmailProviderName,
  EmailSenderPurpose,
  SmtpEmailProviderConfig,
} from './email.types.js';

/**
 * Email transport configuration. Switching mail hosts only requires changing
 * EMAIL_PROVIDER (titan, gmail, microsoft, zoho, godaddy) or using `smtp` with
 * explicit EMAIL_SMTP_* values for any other server.
 */

interface ProviderPreset {
  host: string;
  port: number;
  secure: boolean;
}

const PROVIDER_PRESETS: Record<Exclude<EmailProviderName, 'smtp'>, ProviderPreset> = {
  gmail: { host: 'smtp.gmail.com', port: 587, secure: false },
  titan: { host: 'smtp.titan.email', port: 465, secure: true },
  godaddy: { host: 'smtpout.secureserver.net', port: 465, secure: true },
  microsoft: { host: 'smtp.office365.com', port: 587, secure: false },
  zoho: { host: 'smtp.zoho.com', port: 465, secure: true },
};

const PROVIDER_ALIASES: Record<string, EmailProviderName> = {
  google: 'gmail',
  'go-daddy': 'godaddy',
  'godaddy-titan': 'titan',
  'titan-email': 'titan',
  office365: 'microsoft',
  microsoft365: 'microsoft',
  m365: 'microsoft',
  outlook: 'microsoft',
  'zoho-mail': 'zoho',
};

const SUPPORTED = 'titan, gmail, microsoft, zoho, godaddy, smtp';

function optional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return value.trim().toLowerCase() === 'true';
}

function normalizeProvider(env: NodeJS.ProcessEnv): EmailProviderName {
  const requested = optional(env.EMAIL_PROVIDER)?.toLowerCase();
  if (!requested) {
    // A bare SMTP host configuration is treated as generic SMTP.
    if (optional(env.EMAIL_SMTP_HOST) || optional(env.SMTP_HOST)) return 'smtp';
    throw new Error(`EMAIL_PROVIDER is required. Supported values: ${SUPPORTED}`);
  }

  const aliased = PROVIDER_ALIASES[requested];
  if (aliased) return aliased;
  if (requested === 'smtp' || requested in PROVIDER_PRESETS) return requested as EmailProviderName;

  throw new Error(`Unsupported EMAIL_PROVIDER "${requested}". Supported values: ${SUPPORTED}`);
}

export function loadEmailProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
): SmtpEmailProviderConfig {
  const provider = normalizeProvider(env);
  const preset = provider === 'smtp' ? undefined : PROVIDER_PRESETS[provider];

  // Named providers use their own complete connection profile so stale SMTP
  // values do not follow the application when EMAIL_PROVIDER changes.
  const host = preset?.host || optional(env.EMAIL_SMTP_HOST) || optional(env.SMTP_HOST);
  if (!host) throw new Error('EMAIL_SMTP_HOST is required when EMAIL_PROVIDER=smtp');

  const username = optional(env.EMAIL_USERNAME) || optional(env.SMTP_USER);
  const password = optional(env.EMAIL_PASSWORD) || optional(env.SMTP_PASS);
  if (Boolean(username) !== Boolean(password)) {
    throw new Error('Email username and password must either both be set or both be empty');
  }

  return {
    provider,
    host,
    port: preset?.port ?? positiveInteger(env.EMAIL_SMTP_PORT || env.SMTP_PORT, 587),
    secure: preset?.secure ?? boolean(env.EMAIL_SMTP_SECURE || env.SMTP_SECURE, false),
    username,
    password,
    pool: boolean(env.EMAIL_SMTP_POOL, true),
    maxConnections: positiveInteger(env.EMAIL_SMTP_MAX_CONNECTIONS, 5),
    maxMessages: positiveInteger(env.EMAIL_SMTP_MAX_MESSAGES, 100),
  };
}

/** Brand shown as the sender display name and inside email templates. */
export function getBrandName(env: NodeJS.ProcessEnv = process.env): string {
  return (
    optional(env.EMAIL_COMPANY_NAME) ||
    optional(env.EMAIL_FROM_NAME) ||
    optional(env.COMPANY_NAME) ||
    'DocDuniya'
  );
}

export function getPurposeAddress(
  purpose: EmailSenderPurpose,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const purposeVariables: Record<EmailSenderPurpose, string | undefined> = {
    auth: env.EMAIL_AUTH_FROM,
    team: env.EMAIL_TEAM_FROM,
  };
  return optional(purposeVariables[purpose]);
}

export function getEmailAddress(
  purpose: EmailSenderPurpose = 'team',
  overrideAddress?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return (
    optional(overrideAddress) ||
    getPurposeAddress(purpose, env) ||
    optional(env.EMAIL_FROM) ||
    optional(env.EMAIL_USERNAME) ||
    optional(env.SMTP_USER)
  );
}

/** RFC 5322 "From" header. Always presents the brand name, never a staff mailbox name. */
export function getEmailFrom(
  purpose: EmailSenderPurpose = 'team',
  overrideAddress?: string,
  env: NodeJS.ProcessEnv = process.env,
): { header: string; address: string } {
  const address = getEmailAddress(purpose, overrideAddress, env);
  if (!address) throw new Error('EMAIL_FROM or EMAIL_USERNAME is required');
  const name = getBrandName(env).replace(/["\r\n]/g, '');
  return { header: `"${name}" <${address}>`, address };
}
