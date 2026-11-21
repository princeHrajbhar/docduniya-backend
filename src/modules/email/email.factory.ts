import { logger } from '../../config/logger.js';
import { loadEmailProviderConfig } from './email.config.js';
import type { EmailProvider } from './email.types.js';
import { SmtpEmailProvider } from './providers/smtp.provider.js';

let providerInstance: EmailProvider | undefined;

/** Lazily creates the configured provider so the API can boot without email settings. */
export function getEmailProvider(): EmailProvider {
  if (providerInstance) return providerInstance;

  const config = loadEmailProviderConfig();
  providerInstance = new SmtpEmailProvider(config);
  logger.info(
    {
      emailProvider: providerInstance.name,
      smtpHost: config.host,
      smtpPort: config.port,
      smtpSecure: config.secure,
    },
    'Email provider initialized',
  );
  return providerInstance;
}

export async function verifyEmailProvider(): Promise<void> {
  const provider = getEmailProvider();
  await provider.verify();
  logger.info({ emailProvider: provider.name }, 'Email provider connection verified');
}

export function closeEmailProvider(): void {
  providerInstance?.close();
  providerInstance = undefined;
}
