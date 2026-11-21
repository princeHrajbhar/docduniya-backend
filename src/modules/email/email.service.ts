import mongoose from 'mongoose';
import { logger } from '../../config/logger.js';
import { AppError, ErrorCode } from '../../utils/app-error.js';
import { getEmailFrom } from './email.config.js';
import { getEmailProvider } from './email.factory.js';
import { EmailLog, EmailSuppression, type EmailDeliveryStatus } from './email.model.js';
import { stripEmailHtml } from './email.templates.js';
import type { SendEmailInput, SendEmailResult } from './email.types.js';

const normalizeAddress = (email: string): string => email.trim().toLowerCase();

export async function isEmailSuppressed(email: string): Promise<boolean> {
  return Boolean(await EmailSuppression.exists({ email: normalizeAddress(email) }));
}

/**
 * Sends one transactional email directly through the configured provider.
 *
 * - Suppressed recipients are never contacted (throws EMAIL_SUPPRESSED).
 * - Every attempt is written to the delivery log; bodies of `sensitive`
 *   messages (codes, reset links) are never stored.
 * - Provider failures throw EMAIL_DELIVERY_FAILED (502) after logging the cause.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const message = normalize(input);

  if (await isEmailSuppressed(message.to)) {
    await recordDelivery(message, 'blocked').catch(() => undefined);
    throw new AppError(
      `Email communication is blocked for ${message.to}`,
      409,
      ErrorCode.EMAIL_SUPPRESSED,
    );
  }

  let senderEmail: string | undefined;
  try {
    const from = getEmailFrom(message.senderPurpose ?? 'team', message.fromEmail);
    senderEmail = from.address;
    const info = await getEmailProvider().send({
      from: from.header,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text ?? stripEmailHtml(message.html),
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      ...(message.template ? { headers: { 'X-Email-Template': message.template } } : {}),
    });

    logger.info(
      { to: message.to, template: message.template, messageId: info.messageId },
      'Email sent',
    );
    await recordDelivery(message, 'sent', { senderEmail, providerMessageId: info.messageId }).catch(
      (error: unknown) =>
        logger.error(
          { err: error, to: message.to },
          'Email sent but the delivery log could not be written',
        ),
    );
    return { messageId: info.messageId, to: message.to };
  } catch (error) {
    logger.error(
      { err: error, to: message.to, template: message.template },
      'Email delivery failed',
    );
    await recordDelivery(message, 'failed', {
      senderEmail,
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
    throw new AppError(
      'The email could not be delivered. Please try again later.',
      502,
      ErrorCode.EMAIL_DELIVERY_FAILED,
    );
  }
}

function normalize(input: SendEmailInput): SendEmailInput {
  const to = normalizeAddress(input.to);
  const subject = input.subject.trim();
  const html = input.html.trim();
  if (!to || !subject || !html) throw new Error('Email requires to, subject and html');
  return {
    ...input,
    to,
    subject,
    html,
    ...(input.fromEmail ? { fromEmail: normalizeAddress(input.fromEmail) } : {}),
  };
}

const asObjectId = (value?: string) =>
  value && mongoose.isValidObjectId(value) ? new mongoose.Types.ObjectId(value) : undefined;

async function recordDelivery(
  message: SendEmailInput,
  status: EmailDeliveryStatus,
  extra: { senderEmail?: string; providerMessageId?: string; error?: string } = {},
): Promise<void> {
  await EmailLog.create({
    to: message.to,
    subject: message.subject.slice(0, 240),
    status,
    sensitive: message.sensitive === true,
    ...(message.sensitive
      ? {}
      : { bodyText: (message.text ?? stripEmailHtml(message.html)).slice(0, 100_000) }),
    ...(message.template ? { template: message.template } : {}),
    ...(message.senderPurpose ? { senderPurpose: message.senderPurpose } : {}),
    ...(extra.senderEmail ? { senderEmail: extra.senderEmail } : {}),
    ...(extra.providerMessageId ? { providerMessageId: extra.providerMessageId } : {}),
    ...(extra.error ? { error: extra.error.slice(0, 1000) } : {}),
    ...(asObjectId(message.actorUserId) ? { actorUserId: asObjectId(message.actorUserId) } : {}),
    ...(asObjectId(message.linkedUserId) ? { linkedUserId: asObjectId(message.linkedUserId) } : {}),
    ...(message.relatedType ? { relatedType: message.relatedType } : {}),
    ...(message.relatedId ? { relatedId: message.relatedId } : {}),
  });
}
