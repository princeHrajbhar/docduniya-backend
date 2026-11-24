import { z } from 'zod';
import {
  addressInput,
  contactsInput,
  dateOnly,
  label,
  objectId,
  paginationInput,
  version,
} from '../../shared/domain/healthcare.js';

const reason = z.string().trim().min(5).max(1000);
const count = z.number().int().min(1).max(1_000_000);
const code = z
  .string()
  .regex(/^[A-Z0-9][A-Z0-9-]{0,59}$/, 'Use uppercase letters, digits and hyphens');

export const drugInput = z.strictObject({
  system: label,
  code: z.string().trim().min(1).max(100),
  release: z.string().trim().min(1).max(60),
  genericName: label,
  brandName: label.optional(),
  form: z.string().trim().min(1).max(100),
  strength: z.string().trim().max(100).optional(),
  routes: z.array(z.string().trim().min(1).max(60)).max(10).default([]),
  manufacturer: label.optional(),
  licenseReference: label,
});
export const inventoryItemInput = z
  .strictObject({
    sku: code,
    kind: z.enum(['DRUG', 'CONSUMABLE', 'IMPLANT', 'OTHER']),
    drugId: objectId.optional(),
    name: label,
    stockUnit: z.string().trim().min(1).max(40),
    reorderPoint: z.number().int().min(0).max(1_000_000).default(0),
    salePriceMinor: z.number().int().min(0).max(100_000_000).default(0),
    taxBasisPoints: z.number().int().min(0).max(10_000).default(0),
  })
  .refine((v) => v.kind !== 'DRUG' || v.drugId, {
    path: ['drugId'],
    message: 'Drugs reference the reviewed catalog',
  });
export const supplierInput = z.strictObject({
  code,
  legalName: label,
  address: addressInput.optional(),
  contacts: contactsInput,
  licenseIdentifiers: z
    .array(
      z.strictObject({
        system: label,
        value: z.string().trim().min(1).max(100),
        expiresOn: dateOnly.optional(),
      }),
    )
    .max(20)
    .default([]),
});
export const purchaseOrderInput = z.strictObject({
  supplierId: objectId,
  destinationId: objectId,
  lines: z
    .array(
      z.strictObject({
        itemId: objectId,
        quantity: count,
        unitCostMinor: z.number().int().min(0).max(100_000_000),
      }),
    )
    .min(1)
    .max(200),
});
export const purchaseOrderActionInput = z.strictObject({
  expectedVersion: version,
  action: z.enum(['approve', 'order', 'cancel']),
  reason: reason.optional(),
});
export const goodsReceiptInput = z.strictObject({
  expectedVersion: version,
  supplierInvoiceNumber: z.string().trim().max(60).optional(),
  lines: z
    .array(
      z.strictObject({
        purchaseLine: z.number().int().min(1),
        batchNumber: z.string().trim().min(1).max(60),
        manufacturer: label,
        manufacturedOn: dateOnly.optional(),
        expiresOn: dateOnly,
        accepted: z.number().int().min(0).max(1_000_000),
        rejected: z.number().int().min(0).max(1_000_000).default(0),
      }),
    )
    .min(1)
    .max(200),
});
export const batchActionInput = z.strictObject({
  expectedVersion: version,
  action: z.enum(['release', 'recall']),
  reason,
});
export const adjustmentInput = z.strictObject({
  batchId: objectId,
  locationId: objectId,
  quantityDelta: z
    .number()
    .int()
    .min(-1_000_000)
    .max(1_000_000)
    .refine((v) => v !== 0, 'Use a nonzero quantity'),
  reason: z.enum(['ADJUST', 'WASTE']),
  note: reason,
});
export const transferInput = z.strictObject({
  batchId: objectId,
  fromLocationId: objectId,
  toLocationId: objectId,
  quantity: count,
});
export const dispenseInput = z.strictObject({
  prescriptionId: objectId,
  pharmacyFacilityId: objectId,
  lines: z
    .array(
      z.strictObject({
        prescriptionItemId: objectId,
        inventoryItemId: objectId,
        batchId: objectId,
        locationId: objectId,
        quantity: count,
        substitutionReason: reason.optional(),
      }),
    )
    .min(1)
    .max(100),
  allergyOverrideReason: reason.optional(),
});
export const dispenseReturnInput = z.strictObject({
  expectedVersion: version,
  lines: z
    .array(z.strictObject({ line: z.number().int().min(1), quantity: count }))
    .min(1)
    .max(100),
  reason,
});
export const stockQuery = paginationInput.extend({
  locationId: objectId.optional(),
  itemId: objectId.optional(),
  expiringWithinDays: z.coerce.number().int().min(1).max(365).optional(),
});
export const catalogSearch = paginationInput.extend({ q: z.string().trim().max(60).optional() });
