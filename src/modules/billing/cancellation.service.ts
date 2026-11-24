import type { ClientSession } from 'mongoose';
import type { OperationActor } from '../../shared/application/scope.js';
import type { Appointment } from '../appointments/appointment.model.js';
import { Invoice, Payment, PaymentIntent } from './billing.model.js';
import { creditInvoice, reserveRefund } from './invoice.service.js';

type AppointmentDocument = ReturnType<typeof Appointment.hydrate>;

/** Refund share in basis points from the policy snapshot accepted at booking. */
export function refundBasisPoints(
  appointment: Pick<AppointmentDocument, 'startAt' | 'cancellationPolicy'>,
  initiatedBy: 'PROVIDER' | 'PATIENT',
  now = new Date(),
): number {
  if (initiatedBy === 'PROVIDER') return 10_000;
  const policy = appointment.cancellationPolicy;
  const deadline = appointment.startAt.getTime() - policy.noticeHours * 3600_000;
  return now.getTime() <= deadline ? policy.refundBeforeBps : policy.refundAfterBps;
}

/**
 * Runs inside the cancellation transaction. It credits the invoice and reserves the refund; the
 * gateway call happens after commit in the refund worker. A refund failure never reverses the
 * cancellation. A capture still in flight is handled by capture processing, because the hold is
 * no longer valid when it arrives.
 */
export async function settleCancellation(
  actor: OperationActor,
  appointment: AppointmentDocument,
  session: ClientSession,
  initiatedBy: 'PROVIDER' | 'PATIENT',
): Promise<void> {
  if (appointment.paymentPolicy !== 'PREPAY') return;
  const intent = await PaymentIntent.findOne({
    appointmentId: appointment._id,
    status: 'SUCCEEDED',
    outcome: 'CONFIRMED',
  }).session(session);
  if (!intent) return;
  const payment = await Payment.findOne({ intentId: intent._id, status: 'CAPTURED' }).session(
    session,
  );
  if (!payment) return;
  const basisPoints = refundBasisPoints(appointment, initiatedBy);
  const refundable = Math.floor((payment.amountMinor * basisPoints) / 10_000);
  if (refundable <= 0) return;
  const reason =
    initiatedBy === 'PROVIDER'
      ? 'Provider cancelled the appointment'
      : 'Patient cancellation under the accepted policy';
  const invoice = await Invoice.findOne({
    organizationId: appointment.organizationId,
    appointmentId: appointment._id,
    status: 'ISSUED',
  }).session(session);
  const key = `cancel:${appointment._id}`;
  const note = invoice
    ? await creditInvoice(
        actor,
        invoice,
        [{ lineNumber: 1, totalMinor: refundable }],
        reason,
        key,
        true,
        session,
      )
    : undefined;
  // Reversing the allocation saved the payment; reserve against its current state.
  const current = await Payment.findById(payment._id).session(session);
  await reserveRefund(actor, current!, refundable, reason, key, session, note?._id);
}
