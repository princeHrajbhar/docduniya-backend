import { z } from 'zod';
import { EMAIL_DELIVERY_STATUSES } from './email.model.js';

const email = z.string().trim().toLowerCase().email('Invalid email format').max(254);

const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};

export const blockEmailSchema = z
  .object({ email, reason: z.string().trim().max(500).optional() })
  .strict();

export const emailParamsSchema = z.object({ email });

export const suppressionListSchema = z
  .object({ ...pagination, search: z.string().trim().max(254).optional() })
  .strict();

export const emailLogQuerySchema = z
  .object({
    ...pagination,
    search: z.string().trim().max(254).optional(),
    status: z.enum(EMAIL_DELIVERY_STATUSES).optional(),
    template: z.string().trim().max(160).optional(),
  })
  .strict();

export type EmailLogQuery = z.infer<typeof emailLogQuerySchema>;
export type SuppressionListQuery = z.infer<typeof suppressionListSchema>;
