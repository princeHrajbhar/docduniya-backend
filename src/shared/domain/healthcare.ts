import { z } from 'zod';

export const objectId = z
  .string()
  .regex(/^[a-fA-F0-9]{24}$/, 'Invalid identifier')
  .transform((v) => v.toLowerCase());
export const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const label = z.string().trim().min(1).max(200);
export const dateOnly = z.iso.date();
export function todayInIndia(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}
export const nameInput = z.strictObject({
  display: label,
  given: label.optional(),
  middle: label.optional(),
  family: label.optional(),
  prefix: z.string().trim().max(30).optional(),
  native: label.optional(),
});
export const addressInput = z
  .strictObject({
    use: z.enum(['HOME', 'WORK', 'MAILING', 'TEMPORARY']),
    line1: label,
    line2: label.optional(),
    locality: label.optional(),
    city: label,
    district: label.optional(),
    stateCode: z.string().trim().min(1).max(50),
    postalCode: z.string().trim().min(1).max(20),
    countryCode: z.literal('IN').default('IN'),
  })
  .refine((v) => /^\d{6}$/.test(v.postalCode), {
    path: ['postalCode'],
    message: 'Enter a six-digit Indian PIN code',
  });
export const contactInput = z
  .strictObject({
    kind: z.enum(['PHONE', 'EMAIL']),
    value: z.string().trim().min(1).max(254),
    use: z.enum(['PERSONAL', 'WORK', 'EMERGENCY']),
  })
  .superRefine((v, ctx) => {
    const valid =
      v.kind === 'EMAIL' ? z.email().safeParse(v.value).success : /^\+[1-9]\d{7,14}$/.test(v.value);
    if (!valid)
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'Use a valid email or E.164 phone number',
      });
  })
  .transform((v) => ({ ...v, normalized: v.kind === 'EMAIL' ? v.value.toLowerCase() : v.value }));
export const contactsInput = z.array(contactInput).max(10).default([]);
export const addressesInput = z.array(addressInput).max(10).default([]);
export const languagesInput = z.array(z.string().trim().min(2).max(35)).max(30).default(['en']);
export const paginationInput = z.strictObject({
  before: objectId.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type Pagination = z.infer<typeof paginationInput>;
export interface Actor {
  kind: 'USER' | 'SERVICE';
  id: string;
}
export interface CommandActor {
  userId: string;
  requestId: string;
}
export interface CommandResult {
  id: string;
  version: number;
}

export function assertDateRange(start: string, end?: string): boolean {
  return !end || end >= start;
}
