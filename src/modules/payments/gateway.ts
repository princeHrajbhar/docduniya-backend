import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';
import { ApiError } from '../../utils/api-error.js';

export interface GatewayCredentials {
  keyId: string;
  keySecret: string;
}
export interface GatewayOrder {
  id: string;
  amountMinor: number;
  currency: string;
  receipt?: string;
}
export interface GatewayPayment {
  id: string;
  orderId?: string;
  amountMinor: number;
  currency: string;
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
  errorCode?: string;
}
export interface GatewayRefund {
  id: string;
  paymentId: string;
  amountMinor: number;
  status: 'pending' | 'processed' | 'failed';
}

/** The outcome is unknown (timeout, network or 5xx). Reconcile before creating anything new. */
export class GatewayUnavailableError extends Error {
  constructor(message = 'Payment gateway outcome is unknown') {
    super(message);
    this.name = 'GatewayUnavailableError';
  }
}
/** The gateway definitively rejected the request. */
export class GatewayRejectedError extends Error {
  constructor(public readonly code: string) {
    super(`Payment gateway rejected the request: ${code}`);
    this.name = 'GatewayRejectedError';
  }
}

export interface PaymentGateway {
  createOrder(
    credentials: GatewayCredentials,
    input: {
      amountMinor: number;
      currency: string;
      receipt: string;
      notes: Record<string, string>;
    },
  ): Promise<GatewayOrder>;
  findOrderByReceipt(
    credentials: GatewayCredentials,
    receipt: string,
  ): Promise<GatewayOrder | undefined>;
  fetchPayment(credentials: GatewayCredentials, paymentId: string): Promise<GatewayPayment>;
  capturePayment(credentials: GatewayCredentials, payment: GatewayPayment): Promise<GatewayPayment>;
  listPayments(credentials: GatewayCredentials, from: Date, to: Date): Promise<GatewayPayment[]>;
  createRefund(
    credentials: GatewayCredentials,
    input: { paymentId: string; amountMinor: number; idempotencyKey: string },
  ): Promise<GatewayRefund>;
}

type RazorpayPayment = {
  id: string;
  order_id?: string | null;
  amount: number;
  currency: string;
  status: GatewayPayment['status'];
  error_code?: string | null;
};
type RazorpayRefund = {
  id: string;
  payment_id: string;
  amount: number;
  status: GatewayRefund['status'];
};
type RazorpayOrder = { id: string; amount: number; currency: string; receipt?: string };

const toPayment = (row: RazorpayPayment): GatewayPayment => ({
  id: row.id,
  orderId: row.order_id ?? undefined,
  amountMinor: row.amount,
  currency: row.currency,
  status: row.status,
  errorCode: row.error_code ?? undefined,
});
const toOrder = (row: RazorpayOrder): GatewayOrder => ({
  id: row.id,
  amountMinor: row.amount,
  currency: row.currency,
  receipt: row.receipt,
});

/** Razorpay REST adapter. Request/response bodies are never logged. */
export class RazorpayGateway implements PaymentGateway {
  constructor(private readonly baseUrl = env.RAZORPAY_API_BASE) {}

  private async call<T>(
    credentials: GatewayCredentials,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${credentials.keyId}:${credentials.keySecret}`).toString('base64')}`,
          'Content-Type': 'application/json',
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new GatewayUnavailableError();
    }
    if (response.status >= 500 || response.status === 429) throw new GatewayUnavailableError();
    const payload = (await response.json().catch(() => ({}))) as {
      error?: { code?: string; reason?: string };
    };
    if (!response.ok)
      throw new GatewayRejectedError(
        payload.error?.reason ?? payload.error?.code ?? `HTTP_${response.status}`,
      );
    return payload as T;
  }

  async createOrder(
    credentials: GatewayCredentials,
    input: Parameters<PaymentGateway['createOrder']>[1],
  ) {
    return toOrder(
      await this.call<RazorpayOrder>(credentials, 'POST', '/orders', {
        amount: input.amountMinor,
        currency: input.currency,
        receipt: input.receipt,
        notes: input.notes,
        partial_payment: false,
      }),
    );
  }
  async findOrderByReceipt(credentials: GatewayCredentials, receipt: string) {
    const result = await this.call<{ items: RazorpayOrder[] }>(
      credentials,
      'GET',
      `/orders?receipt=${encodeURIComponent(receipt)}&count=1`,
    );
    return result.items[0] ? toOrder(result.items[0]) : undefined;
  }
  async fetchPayment(credentials: GatewayCredentials, paymentId: string) {
    return toPayment(
      await this.call<RazorpayPayment>(
        credentials,
        'GET',
        `/payments/${encodeURIComponent(paymentId)}`,
      ),
    );
  }
  async capturePayment(credentials: GatewayCredentials, payment: GatewayPayment) {
    return toPayment(
      await this.call<RazorpayPayment>(
        credentials,
        'POST',
        `/payments/${encodeURIComponent(payment.id)}/capture`,
        { amount: payment.amountMinor, currency: payment.currency },
      ),
    );
  }
  async listPayments(credentials: GatewayCredentials, from: Date, to: Date) {
    const rows: GatewayPayment[] = [];
    for (let skip = 0; skip < 10_000; skip += 100) {
      const page = await this.call<{ items: RazorpayPayment[] }>(
        credentials,
        'GET',
        `/payments?from=${Math.floor(from.getTime() / 1000)}&to=${Math.floor(to.getTime() / 1000)}&count=100&skip=${skip}`,
      );
      rows.push(...page.items.map(toPayment));
      if (page.items.length < 100) break;
    }
    return rows;
  }
  async createRefund(
    credentials: GatewayCredentials,
    input: Parameters<PaymentGateway['createRefund']>[1],
  ) {
    const row = await this.call<RazorpayRefund>(
      credentials,
      'POST',
      `/payments/${encodeURIComponent(input.paymentId)}/refund`,
      { amount: input.amountMinor, speed: 'normal', receipt: input.idempotencyKey.slice(0, 40) },
      // Razorpay deduplicates refunds carrying the same idempotency key.
      { 'X-Refund-Idempotency': input.idempotencyKey },
    );
    return { id: row.id, paymentId: row.payment_id, amountMinor: row.amount, status: row.status };
  }
}

let gateway: PaymentGateway = new RazorpayGateway();
export const paymentGateway = () => gateway;
/** Test and sandbox seam. Production composition keeps the Razorpay adapter. */
export function setPaymentGateway(next: PaymentGateway): void {
  gateway = next;
}

const hmac = (secret: string, value: string | Buffer) =>
  createHmac('sha256', secret).update(value).digest('hex');

export function signaturesMatch(expectedHex: string, receivedHex: string): boolean {
  const expected = Buffer.from(expectedHex, 'hex');
  const received = Buffer.from(receivedHex, 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received);
}
/** Verifies the webhook signature over the exact raw request bytes. */
export const verifyWebhookSignature = (secret: string, rawBody: Buffer, signature: string) =>
  /^[a-f0-9]{64}$/.test(signature) && signaturesMatch(hmac(secret, rawBody), signature);
/** Verifies Razorpay Checkout's order|payment signature. */
export const verifyCheckoutSignature = (
  keySecret: string,
  orderId: string,
  paymentId: string,
  signature: string,
) => signaturesMatch(hmac(keySecret, `${orderId}|${paymentId}`), signature);
export const sign = hmac;

/**
 * Resolves `env:NAME` secret references. Only RAZORPAY_* names are readable, so a provider admin
 * cannot point a reference at an unrelated application secret.
 */
export function resolveSecret(reference: string): string {
  const match = /^env:(RAZORPAY_[A-Z0-9_]{1,80})$/.exec(reference);
  const value = match ? process.env[match[1]!] : undefined;
  if (!value)
    throw new ApiError(
      503,
      'The merchant secret is not configured on this deployment',
      undefined,
      'MERCHANT_SECRET_UNAVAILABLE',
    );
  return value;
}
