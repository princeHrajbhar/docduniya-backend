export type EmailProviderName = 'gmail' | 'titan' | 'godaddy' | 'microsoft' | 'zoho' | 'smtp';

/** Selects which configured "from" mailbox a message is sent from. */
export const EMAIL_SENDER_PURPOSES = ['auth', 'team'] as const;
export type EmailSenderPurpose = (typeof EMAIL_SENDER_PURPOSES)[number];

export interface EmailMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

export interface EmailSendResult {
  messageId: string;
}

export interface EmailProvider {
  readonly name: EmailProviderName;
  send(message: EmailMessage): Promise<EmailSendResult>;
  verify(): Promise<void>;
  close(): void;
}

export interface SmtpEmailProviderConfig {
  provider: EmailProviderName;
  host: string;
  port: number;
  secure: boolean;
  username?: string;
  password?: string;
  pool: boolean;
  maxConnections: number;
  maxMessages: number;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  /** Plain-text alternative. Generated from `html` when omitted. */
  text?: string;
  replyTo?: string;
  /** Explicit sender address; otherwise resolved from `senderPurpose`. */
  fromEmail?: string;
  senderPurpose?: EmailSenderPurpose;
  /** Template identifier, recorded in the delivery log and an `X-Email-Template` header. */
  template?: string;
  /**
   * Messages carrying OTP codes, reset links or other secrets. Their bodies are
   * never written to the delivery log.
   */
  sensitive?: boolean;
  actorUserId?: string;
  linkedUserId?: string;
  relatedType?: string;
  relatedId?: string;
}

export interface SendEmailResult {
  messageId: string;
  to: string;
}
