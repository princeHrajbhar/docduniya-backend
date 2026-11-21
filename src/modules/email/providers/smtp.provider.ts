import nodemailer, { type Transporter } from 'nodemailer';
import type {
  EmailMessage,
  EmailProvider,
  EmailSendResult,
  SmtpEmailProviderConfig,
} from '../email.types.js';

export class SmtpEmailProvider implements EmailProvider {
  readonly name;
  private readonly transporter: Transporter;

  constructor(config: SmtpEmailProviderConfig) {
    this.name = config.provider;

    const base = {
      host: config.host,
      port: config.port,
      secure: config.secure,
      ...(config.username && config.password
        ? { auth: { user: config.username, pass: config.password } }
        : {}),
    };

    this.transporter = config.pool
      ? nodemailer.createTransport({
          ...base,
          pool: true,
          maxConnections: config.maxConnections,
          maxMessages: config.maxMessages,
        })
      : nodemailer.createTransport(base);
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const info = (await this.transporter.sendMail(message)) as { messageId: string };
    return { messageId: info.messageId };
  }

  async verify(): Promise<void> {
    await this.transporter.verify();
  }

  close(): void {
    this.transporter.close();
  }
}
