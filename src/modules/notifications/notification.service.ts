import type { ClientSession } from 'mongoose';
import type { CommandActor, Pagination } from '../../shared/domain/healthcare.js';
import { before, pageOf } from '../../shared/application/scope.js';
import { ApiError } from '../../utils/api-error.js';
import { User } from '../admin/auth/models/user.model.js';
import { sendEmail } from '../email/index.js';
import { Appointment } from '../appointments/appointment.model.js';
import { Organization } from '../organizations/organization.model.js';
import { Patient } from '../patients/patient.model.js';
import { Practitioner } from '../practitioners/practitioner.model.js';
import { ClinicalTask, Prescription } from '../clinical/clinical.model.js';
import { DiagnosticReport } from '../diagnostics/diagnostic.model.js';
import { Refund, Payment, PaymentIntent } from '../billing/billing.model.js';
import { ClinicalDocument } from '../documents/document.model.js';
import { Membership } from '../access/access.model.js';
import { Notification, NotificationTemplate } from './notification.model.js';

/** Approved built-in templates. External channels never carry clinical narrative. */
export const BUILTIN_TEMPLATES = [
  {
    code: 'APPOINTMENT_CONFIRMED',
    subject: 'Appointment {{bookingNumber}} confirmed',
    body: 'Your appointment with {{provider}} is confirmed for {{startAt}}.',
    allowedVariables: ['bookingNumber', 'provider', 'startAt'],
  },
  {
    code: 'APPOINTMENT_REMINDER',
    subject: 'Reminder: appointment {{bookingNumber}}',
    body: 'Reminder: your appointment with {{provider}} is at {{startAt}}.',
    allowedVariables: ['bookingNumber', 'provider', 'startAt'],
  },
  {
    code: 'APPOINTMENT_CANCELLED',
    subject: 'Appointment {{bookingNumber}} cancelled',
    body: 'Your appointment with {{provider}} on {{startAt}} was cancelled.',
    allowedVariables: ['bookingNumber', 'provider', 'startAt'],
  },
  {
    code: 'APPOINTMENT_RESCHEDULED',
    subject: 'Appointment {{bookingNumber}} rescheduled',
    body: 'Your appointment with {{provider}} moved to {{startAt}}.',
    allowedVariables: ['bookingNumber', 'provider', 'startAt'],
  },
  {
    code: 'REFUND_SUCCEEDED',
    subject: 'Refund processed',
    body: 'A refund of INR {{amount}} from {{provider}} has been processed.',
    allowedVariables: ['amount', 'provider'],
  },
  {
    code: 'RECORD_AVAILABLE',
    subject: 'A new health record is available',
    body: 'A new {{recordType}} from {{provider}} is available in your DocDuniya account.',
    allowedVariables: ['recordType', 'provider'],
  },
  {
    code: 'CLINICAL_TASK',
    subject: 'Clinical task requires attention',
    body: '{{priority}} task: {{title}}.',
    allowedVariables: ['priority', 'title'],
  },
  {
    code: 'MEMBERSHIP_INVITED',
    subject: 'Invitation to join {{provider}}',
    body: 'You have been invited to join {{provider}} on DocDuniya. Sign in to respond.',
    allowedVariables: ['provider'],
  },
  {
    code: 'DOCUMENT_STATUS',
    subject: 'Document {{status}}',
    body: 'Your uploaded document "{{title}}" is {{status}}.',
    allowedVariables: ['title', 'status'],
  },
] as const;
type TemplateCode = (typeof BUILTIN_TEMPLATES)[number]['code'];

export async function seedNotificationTemplates(): Promise<void> {
  const approvedBy = { kind: 'SERVICE' as const, id: 'notification-templates-v1' };
  for (const template of BUILTIN_TEMPLATES)
    for (const channel of ['EMAIL', 'IN_APP'] as const)
      await NotificationTemplate.updateOne(
        { code: template.code, versionNumber: 1, channel, language: 'en' },
        {
          $setOnInsert: {
            ...template,
            allowedVariables: [...template.allowedVariables],
            channel,
            language: 'en',
            versionNumber: 1,
            approvedBy,
          },
        },
        { upsert: true },
      );
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );

async function render(
  code: TemplateCode,
  channel: 'EMAIL' | 'IN_APP',
  variables: Map<string, string> | Record<string, string>,
) {
  const stored = await NotificationTemplate.findOne({ code, channel, language: 'en' })
    .sort({ versionNumber: -1 })
    .lean();
  const template = stored ?? BUILTIN_TEMPLATES.find((entry) => entry.code === code)!;
  const values = variables instanceof Map ? Object.fromEntries(variables) : variables;
  const fill = (text: string, html: boolean) =>
    text.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
      if (!template.allowedVariables.includes(name as never)) return '';
      const value = values[name] ?? '';
      return html ? escapeHtml(value) : value;
    });
  return {
    subject: fill(template.subject ?? '', false),
    text: fill(template.body, false),
    html: `<p>${fill(template.body, true)}</p>`,
  };
}

const indianTime = (date: Date) =>
  new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);

/** Queues in-app and (optionally) email notifications; the dedupe key makes replays harmless. */
async function queue(
  entry: {
    userId: string;
    organizationId?: string;
    patientId?: string;
    template: TemplateCode;
    source: { type: string; id: string };
    variables: Record<string, string>;
    dedupe: string;
    scheduledAt?: Date;
    email?: boolean;
  },
  session: ClientSession,
) {
  for (const channel of entry.email ? (['IN_APP', 'EMAIL'] as const) : (['IN_APP'] as const)) {
    const rendered =
      channel === 'IN_APP' ? await render(entry.template, 'IN_APP', entry.variables) : undefined;
    await Notification.updateOne(
      { dedupeKey: `${entry.dedupe}:${channel}` },
      {
        $setOnInsert: {
          userId: entry.userId,
          organizationId: entry.organizationId,
          patientId: entry.patientId,
          templateCode: entry.template,
          channel,
          source: entry.source,
          variables: entry.variables,
          scheduledAt: entry.scheduledAt ?? new Date(),
          // In-app reminders surface when due; immediate in-app messages are visible at once.
          status: channel === 'IN_APP' && !entry.scheduledAt ? 'SENT' : 'PENDING',
          sentAt: channel === 'IN_APP' && !entry.scheduledAt ? new Date() : undefined,
          title: rendered?.subject,
          body: rendered?.text,
        },
      },
      { upsert: true, session },
    );
  }
}

async function patientUser(patientId: string, session: ClientSession) {
  const patient = await Patient.findById(patientId)
    .select({ ownerUserId: 1 })
    .session(session)
    .lean();
  return patient?.ownerUserId ? String(patient.ownerUserId) : undefined;
}
async function providerName(organizationId: string, session: ClientSession) {
  return (
    (await Organization.findById(organizationId).select({ displayName: 1 }).session(session).lean())
      ?.displayName ?? 'your provider'
  );
}

/** Outbox consumer: turns domain events into recipient-scoped notifications. */
export async function notificationConsumer(
  event: { eventId: string; type: string; aggregateId: string; organizationId?: string },
  session: ClientSession,
) {
  const appointmentTemplates: Record<string, TemplateCode> = {
    AppointmentConfirmed: 'APPOINTMENT_CONFIRMED',
    AppointmentCancelledByProvider: 'APPOINTMENT_CANCELLED',
    AppointmentCancelledByPatient: 'APPOINTMENT_CANCELLED',
    AppointmentRescheduled: 'APPOINTMENT_RESCHEDULED',
  };
  if (appointmentTemplates[event.type]) {
    const appointment = await Appointment.findById(event.aggregateId).session(session);
    if (!appointment) return;
    const variables = {
      bookingNumber: appointment.bookingNumber ?? '',
      provider: await providerName(String(appointment.organizationId), session),
      startAt: indianTime(appointment.startAt),
    };
    const base = {
      userId: String(appointment.bookedBy),
      organizationId: String(appointment.organizationId),
      patientId: String(appointment.patientId),
      source: { type: 'appointment', id: String(appointment._id) },
      variables,
    };
    await queue(
      {
        ...base,
        template: appointmentTemplates[event.type]!,
        dedupe: `${event.eventId}`,
        email: true,
      },
      session,
    );
    if (
      event.type !== 'AppointmentCancelledByProvider' &&
      event.type !== 'AppointmentCancelledByPatient'
    ) {
      const remindAt = new Date(appointment.startAt.getTime() - 24 * 3600_000);
      if (remindAt > new Date())
        await queue(
          {
            ...base,
            template: 'APPOINTMENT_REMINDER',
            dedupe: `reminder:${appointment._id}:${appointment.startAt.toISOString()}`,
            scheduledAt: remindAt,
            email: true,
          },
          session,
        );
    }
    return;
  }
  if (event.type === 'RefundSucceeded') {
    const refund = await Refund.findById(event.aggregateId).session(session);
    const payment = refund ? await Payment.findById(refund.paymentId).session(session) : null;
    const intent = payment?.intentId
      ? await PaymentIntent.findById(payment.intentId).session(session)
      : null;
    if (!refund || !intent?.payerUserId) return;
    await queue(
      {
        userId: String(intent.payerUserId),
        organizationId: String(refund.organizationId),
        template: 'REFUND_SUCCEEDED',
        source: { type: 'refund', id: String(refund._id) },
        variables: {
          amount: (refund.amountMinor / 100).toFixed(2),
          provider: await providerName(String(refund.organizationId), session),
        },
        dedupe: event.eventId,
        email: true,
      },
      session,
    );
    return;
  }
  if (
    ['CriticalResultTaskCreated', 'ClinicalTaskEscalated', 'ClinicalTaskCreated'].includes(
      event.type,
    )
  ) {
    const task = await ClinicalTask.findById(event.aggregateId).session(session);
    const practitioner = task?.assigneeId
      ? await Practitioner.findById(task.assigneeId).session(session)
      : null;
    if (!task || !practitioner?.userId) return;
    // In-app only: task titles may carry clinical context.
    await queue(
      {
        userId: String(practitioner.userId),
        organizationId: String(task.organizationId),
        template: 'CLINICAL_TASK',
        source: { type: 'clinicalTask', id: String(task._id) },
        variables: { priority: task.priority, title: task.title },
        dedupe: event.eventId,
      },
      session,
    );
    return;
  }
  if (
    ['DiagnosticReportFinalized', 'CriticalResultFinalized', 'PrescriptionSigned'].includes(
      event.type,
    ) &&
    event.organizationId
  ) {
    const model = event.type === 'PrescriptionSigned' ? 'prescription' : 'diagnostic report';
    const record =
      model === 'prescription'
        ? await Prescription.findById(event.aggregateId).session(session)
        : await DiagnosticReport.findById(event.aggregateId).session(session);
    const userId = record ? await patientUser(String(record.patientId), session) : undefined;
    if (!record || !userId) return;
    await queue(
      {
        userId,
        organizationId: event.organizationId,
        patientId: String(record.patientId),
        template: 'RECORD_AVAILABLE',
        source: {
          type: model === 'prescription' ? 'prescription' : 'diagnosticReport',
          id: event.aggregateId,
        },
        variables: {
          recordType: model,
          provider: await providerName(event.organizationId, session),
        },
        dedupe: event.eventId,
        email: true,
      },
      session,
    );
    return;
  }
  if (event.type === 'MembershipInvited' && event.organizationId) {
    const membership = await Membership.findById(event.aggregateId).session(session);
    if (!membership || membership.status !== 'INVITED') return;
    await queue(
      {
        userId: String(membership.userId),
        organizationId: event.organizationId,
        template: 'MEMBERSHIP_INVITED',
        source: { type: 'membership', id: event.aggregateId },
        variables: { provider: await providerName(event.organizationId, session) },
        dedupe: event.eventId,
        email: true,
      },
      session,
    );
    return;
  }
  if (event.type === 'DocumentAvailable' || event.type === 'DocumentRejected') {
    const document = await ClinicalDocument.findById(event.aggregateId).session(session);
    if (!document) return;
    await queue(
      {
        userId: String(document.uploadedBy),
        template: 'DOCUMENT_STATUS',
        source: { type: 'document', id: event.aggregateId },
        variables: {
          title: document.title,
          status: event.type === 'DocumentAvailable' ? 'available' : 'rejected',
        },
        dedupe: event.eventId,
      },
      session,
    );
  }
}

/** Delivers due notifications, rechecking that the source still warrants the message. */
export async function deliverNotifications(limit = 25): Promise<number> {
  let delivered = 0;
  for (let index = 0; index < limit; index += 1) {
    const now = new Date();
    const row = await Notification.findOneAndUpdate(
      {
        status: 'PENDING',
        scheduledAt: { $lte: now },
        $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lt: now } }],
      },
      { $set: { leaseUntil: new Date(now.getTime() + 60_000) }, $inc: { attempts: 1 } },
      { returnDocument: 'after', sort: { scheduledAt: 1 } },
    );
    if (!row) break;
    const finish = (update: Record<string, unknown>) =>
      Notification.updateOne({ _id: row._id }, { $set: update, $unset: { leaseUntil: 1 } });
    if (row.templateCode === 'APPOINTMENT_REMINDER') {
      const appointment = await Appointment.findById(row.source.id).lean();
      if (
        !appointment ||
        appointment.status !== 'CONFIRMED' ||
        indianTime(appointment.startAt) !== row.variables.get('startAt')
      ) {
        await finish({ status: 'CANCELLED' });
        continue;
      }
    }
    const rendered = await render(row.templateCode as TemplateCode, row.channel, row.variables);
    if (row.channel === 'IN_APP') {
      await finish({
        status: 'SENT',
        sentAt: new Date(),
        title: rendered.subject,
        body: rendered.text,
      });
      delivered += 1;
      continue;
    }
    const user = await User.findOne({ _id: row.userId, isActive: true })
      .select({ email: 1 })
      .lean();
    if (!user?.email) {
      await finish({ status: 'CANCELLED', lastErrorCode: 'RECIPIENT_UNAVAILABLE' });
      continue;
    }
    try {
      const result = await sendEmail({
        to: user.email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        template: row.templateCode,
        senderPurpose: 'team',
        linkedUserId: String(row.userId),
        relatedType: row.source.type,
        relatedId: row.source.id,
      });
      await finish({
        status: 'SENT',
        sentAt: new Date(),
        providerMessageId: (result as { messageId?: string }).messageId,
      });
      delivered += 1;
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'EMAIL_FAILED';
      if (code === 'EMAIL_SUPPRESSED') await finish({ status: 'SUPPRESSED', lastErrorCode: code });
      else if (row.attempts >= 5) await finish({ status: 'FAILED', lastErrorCode: code });
      else
        await finish({
          lastErrorCode: code,
          scheduledAt: new Date(Date.now() + 2 ** row.attempts * 60_000),
        });
    }
  }
  return delivered;
}

export async function listMyNotifications(actor: CommandActor, page: Pagination) {
  const rows = await Notification.find({
    userId: actor.userId,
    channel: 'IN_APP',
    status: 'SENT',
    ...before(page.before),
  })
    .sort({ _id: -1 })
    .limit(page.limit + 1)
    .lean();
  return pageOf(rows, page.limit, (row) => ({
    id: String(row._id),
    title: row.title,
    body: row.body,
    source: row.source,
    sentAt: row.sentAt,
    readAt: row.readAt,
  }));
}

export async function markNotificationRead(actor: CommandActor, notificationId: string) {
  const result = await Notification.updateOne(
    { _id: notificationId, userId: actor.userId, channel: 'IN_APP', readAt: { $exists: false } },
    { $set: { readAt: new Date() } },
  );
  if (
    !result.matchedCount &&
    !(await Notification.exists({ _id: notificationId, userId: actor.userId }))
  )
    throw ApiError.notFound();
  return { id: notificationId, read: true };
}
