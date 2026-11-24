import { z } from 'zod';
import { objectId, version, paginationInput, label } from '../../shared/domain/healthcare.js';

const reason = z.string().trim().min(5).max(1000);
const amount = z.number().int().min(1).max(100_000_000);
const minor = z.number().int().min(0).max(100_000_000);
const secretRef = z
  .string()
  .regex(
    /^env:RAZORPAY_[A-Z0-9_]{1,80}$/,
    'Use an environment reference such as env:RAZORPAY_KEY_SECRET_MAIN; never paste the secret itself',
  );

export const invoiceLineInput = z
  .strictObject({
    description: label,
    serviceCode: z.string().trim().min(1).max(60).optional(),
    quantity: z.number().int().min(1).max(100_000),
    unitPriceMinor: minor,
    discountMinor: minor.default(0),
    taxBasisPoints: z.number().int().min(0).max(10_000).default(0),
  })
  .refine((line) => line.discountMinor <= line.quantity * line.unitPriceMinor, {
    path: ['discountMinor'],
    message: 'Discount cannot exceed the line amount',
  });
export const invoiceInput = z
  .strictObject({
    patientRegistrationId: objectId,
    facilityId: objectId.optional(),
    appointmentId: objectId.optional(),
    chargeItemIds: z.array(objectId).max(100).default([]),
    lines: z.array(invoiceLineInput).max(100).default([]),
    dueInDays: z.number().int().min(0).max(180).default(0),
  })
  .refine((v) => new Set(v.chargeItemIds).size === v.chargeItemIds.length, {
    path: ['chargeItemIds'],
    message: 'Charges must be distinct',
  });
export const expectedVersionInput = z.strictObject({ expectedVersion: version });
export const voidInvoiceInput = z.strictObject({ expectedVersion: version, reason });
export const offlinePaymentInput = z.strictObject({
  patientRegistrationId: objectId,
  method: z.enum(['CASH', 'BANK_TRANSFER', 'CHEQUE', 'UPI_OFFLINE']),
  amountMinor: amount,
  offlineReference: z.string().trim().min(1).max(100).optional(),
  payerName: label.optional(),
  invoiceId: objectId.optional(),
});
export const allocationInput = z.strictObject({ invoiceId: objectId, amountMinor: amount });
export const creditNoteInput = z.strictObject({
  expectedVersion: version,
  reason,
  lines: z
    .array(z.strictObject({ lineNumber: z.number().int().min(1).max(500), totalMinor: amount }))
    .min(1)
    .max(100),
  /** Frees already-allocated payment funds so they can be refunded. */
  reverseAllocations: z.boolean().default(false),
});
export const refundInput = z.strictObject({ amountMinor: amount, reason });
export const merchantInput = z.strictObject({
  provider: z.literal('RAZORPAY'),
  label,
  keyId: z.string().regex(/^rzp_(test|live)_[A-Za-z0-9]{6,40}$/, 'Enter a Razorpay key id'),
  keySecretRef: secretRef,
  webhookSecretRef: secretRef,
});
export const merchantDecisionInput = z.strictObject({
  expectedVersion: version,
  status: z.enum(['ACTIVE', 'RESTRICTED', 'CLOSED']),
  reason,
});
export const checkoutVerificationInput = z.strictObject({
  orderId: z.string().regex(/^order_[A-Za-z0-9]{6,40}$/),
  paymentId: z.string().regex(/^pay_[A-Za-z0-9]{6,40}$/),
  signature: z.string().regex(/^[a-f0-9]{64}$/),
});
export const reconciliationInput = z
  .strictObject({ merchantAccountId: objectId, from: z.iso.datetime(), to: z.iso.datetime() })
  .refine((v) => {
    const span = new Date(v.to).getTime() - new Date(v.from).getTime();
    return span > 0 && span <= 7 * 86400_000;
  }, 'Reconcile at most seven days per run');
export const resolveItemInput = z.strictObject({ expectedVersion: version, resolution: reason });
export const invoiceQuery = paginationInput.extend({
  status: z.enum(['DRAFT', 'ISSUED', 'VOID']).optional(),
  patientRegistrationId: objectId.optional(),
});
export const paymentQuery = paginationInput.extend({ patientRegistrationId: objectId.optional() });
export const chargeQuery = paginationInput.extend({
  patientRegistrationId: objectId,
  status: z.enum(['UNBILLED', 'BILLED', 'REVERSED']).default('UNBILLED'),
});
export const journalQuery = paginationInput.extend({
  sourceType: z
    .string()
    .regex(/^[a-zA-Z]{2,40}$/)
    .optional(),
});
