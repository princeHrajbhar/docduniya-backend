export { sendEmail, isEmailSuppressed } from './email.service.js';
export { verifyEmailProvider, closeEmailProvider } from './email.factory.js';
export {
  emailLayout,
  escapeEmailHtml,
  stripEmailHtml,
  frontendUrl,
  EMAIL_DELIVERY_HINT,
} from './email.templates.js';
export { getBrandName } from './email.config.js';
export { getEmailPreference, blockEmail, unblockEmail } from './suppression.service.js';
export type { SendEmailInput, SendEmailResult, EmailSenderPurpose } from './email.types.js';
