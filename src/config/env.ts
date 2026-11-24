import 'dotenv/config';
import { z } from 'zod';

const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value ? value : undefined));

const booleanString = (fallback: boolean) =>
  z
    .string()
    .trim()
    .toLowerCase()
    .optional()
    .transform((value) => (value ? value === 'true' : fallback));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // ── HTTP ──────────────────────────────────────────────────────────────────
  /** Public frontend origin. Used for CORS, password-reset links and email assets. */
  FRONTEND_URL: z.url().default('http://localhost:3000'),
  /** Extra comma-separated allowed origins. Wildcard subdomains such as https://*.vercel.app are supported. */
  CORS_ORIGINS: z.string().default(''),
  /** Legacy single-value origin setting. `*` is ignored because credentialed CORS cannot use it. */
  CORS_ORIGIN: z.string().default(''),
  RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60 * 1000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(600),

  // ── Database ──────────────────────────────────────────────────────────────
  MONGO_URI: z.string().trim().min(1, 'MONGO_URI is required'),

  // ── Auth ──────────────────────────────────────────────────────────────────
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  AUTH_COOKIE_SAME_SITE: z.enum(['strict', 'lax', 'none']).default('lax'),
  AUTH_COOKIE_DOMAIN: optionalString,
  /** Google Identity Services web client ID. Google sign-in is disabled when empty. */
  GOOGLE_CLIENT_ID: optionalString,

  // ── Email (provider/transport settings are parsed in modules/email/email.config.ts) ──
  VERIFY_SMTP_ON_START: booleanString(false),
  EMAIL_REQUIRED_ON_START: booleanString(false),

  // ── Uploads ───────────────────────────────────────────────────────────────
  /** Media-library uploads are held in memory, so the value is capped at 500 MB. */
  MAX_FILE_SIZE_MB: z.coerce
    .number()
    .positive()
    .default(50)
    .transform((value) => Math.min(value, 500)),
  MAX_FILES_PER_REQUEST: z.coerce.number().int().positive().default(10),

  // ── Private clinical documents (never the public media bucket) ───────────
  PRIVATE_DOCUMENTS_BUCKET: optionalString,
  PRIVATE_DOCUMENTS_REGION: optionalString,
  /** Maximum size of one private document upload, in megabytes. */
  PRIVATE_DOCUMENT_MAX_MB: z.coerce.number().int().min(1).max(100).default(20),
  /** ClamAV clamd host. Files stay quarantined while no scanner is configured. */
  CLAMAV_HOST: optionalString,
  CLAMAV_PORT: z.coerce.number().int().positive().default(3310),

  // ── Payments ──────────────────────────────────────────────────────────────
  RAZORPAY_API_BASE: z.url().default('https://api.razorpay.com/v1'),
  /** Minutes a prepaid appointment hold waits for a verified capture. */
  PAYMENT_HOLD_MINUTES: z.coerce.number().int().min(5).max(30).default(15),

  // ── Background workers ────────────────────────────────────────────────────
  WORKER_POLL_MS: z.coerce.number().int().min(250).max(60_000).default(5000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Logger depends on env, so fall back to console here
  // eslint-disable-next-line no-console
  console.error('Invalid environment variables:', z.flattenError(parsed.error).fieldErrors);
  process.exit(1);
}

export const env = Object.freeze(parsed.data);
export const isProduction = env.NODE_ENV === 'production';
