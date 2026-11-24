import { Schema, model } from 'mongoose';
import {
  actorSchema,
  addressSchema,
  aggregateOptions,
  bounded,
  contactSchema,
  metadataFields,
  ref,
} from '../../shared/persistence/schema.js';

const value = { _id: false, strict: 'throw', versionKey: false } as const;
const appendOnly = {
  strict: 'throw',
  versionKey: false,
  autoIndex: false,
  autoCreate: false,
} as const;
const text = (max: number, required = false) => ({ type: String, maxlength: max, required });
const quantity = { type: Number, required: true, validate: Number.isSafeInteger };
const date = { type: String, match: /^\d{4}-\d{2}-\d{2}$/ };

/** Licensed drug reference data, reviewed by pharmacy governance before activation. */
const drugSchema = new Schema(
  {
    ...metadataFields,
    system: text(200, true),
    code: text(100, true),
    release: text(60, true),
    genericName: text(200, true),
    brandName: text(200),
    form: text(100, true),
    strength: text(100),
    routes: { type: [String], default: [], validate: bounded(10) },
    manufacturer: text(200),
    licenseReference: text(200, true),
    status: { type: String, enum: ['ACTIVE', 'RETIRED'], default: 'ACTIVE' },
  },
  aggregateOptions,
);
drugSchema.index({ system: 1, code: 1, release: 1 }, { unique: true });
drugSchema.index({ genericName: 1, status: 1 });
export const DrugCatalogItem = model('DrugCatalogItem', drugSchema, 'drugCatalog');

const itemSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    sku: text(60, true),
    kind: { type: String, enum: ['DRUG', 'CONSUMABLE', 'IMPLANT', 'OTHER'], required: true },
    drugId: ref('DrugCatalogItem', false),
    name: text(200, true),
    stockUnit: text(40, true),
    reorderPoint: { type: Number, default: 0, min: 0 },
    salePriceMinor: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
    taxBasisPoints: { type: Number, default: 0, min: 0, max: 10_000 },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
  },
  aggregateOptions,
);
itemSchema.index({ organizationId: 1, sku: 1 }, { unique: true });
itemSchema.index({ organizationId: 1, drugId: 1 });
export const InventoryItem = model('InventoryItem', itemSchema, 'inventoryItems');

const supplierSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    code: text(40, true),
    legalName: text(200, true),
    address: addressSchema,
    contacts: { type: [contactSchema], default: [], validate: bounded(10) },
    licenseIdentifiers: {
      type: [
        new Schema({ system: text(100, true), value: text(100, true), expiresOn: date }, value),
      ],
      default: [],
      validate: bounded(20),
    },
    status: { type: String, enum: ['ACTIVE', 'SUSPENDED'], default: 'ACTIVE' },
  },
  aggregateOptions,
);
supplierSchema.index({ organizationId: 1, code: 1 }, { unique: true });
export const Supplier = model('Supplier', supplierSchema, 'suppliers');

const batchSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    itemId: ref('InventoryItem'),
    batchNumber: text(60, true),
    manufacturer: text(200, true),
    manufacturedOn: date,
    expiresOn: { ...date, required: true },
    supplierId: ref('Supplier', false),
    status: {
      type: String,
      enum: ['QUARANTINED', 'RELEASED', 'RECALLED', 'EXPIRED'],
      default: 'QUARANTINED',
    },
    statusReason: text(1000),
  },
  aggregateOptions,
);
batchSchema.index(
  { organizationId: 1, itemId: 1, batchNumber: 1, manufacturer: 1 },
  { unique: true },
);
batchSchema.index({ organizationId: 1, expiresOn: 1, status: 1 });
export const StockBatch = model('StockBatch', batchSchema, 'stockBatches');

/** Cached balance per batch/location; reconciles to immutable movements. Never negative. */
const balanceSchema = new Schema(
  {
    organizationId: ref('Organization'),
    itemId: ref('InventoryItem'),
    batchId: ref('StockBatch'),
    locationId: ref('FacilityLocation'),
    onHand: { ...quantity, min: 0, default: 0 },
    quarantined: { ...quantity, min: 0, default: 0 },
  },
  { timestamps: true, strict: 'throw', versionKey: false, autoIndex: false, autoCreate: false },
);
balanceSchema.index({ organizationId: 1, itemId: 1, batchId: 1, locationId: 1 }, { unique: true });
balanceSchema.index({ organizationId: 1, locationId: 1, itemId: 1 });
export const StockBalance = model('StockBalance', balanceSchema, 'stockBalances');

const movementSchema = new Schema(
  {
    organizationId: ref('Organization'),
    itemId: ref('InventoryItem'),
    batchId: ref('StockBatch'),
    locationId: ref('FacilityLocation'),
    bucket: { type: String, enum: ['ON_HAND', 'QUARANTINED'], required: true },
    quantityDelta: { ...quantity, validate: (v: number) => Number.isSafeInteger(v) && v !== 0 },
    reason: {
      type: String,
      enum: [
        'RECEIVE',
        'RELEASE',
        'DISPENSE',
        'RETURN',
        'TRANSFER_OUT',
        'TRANSFER_IN',
        'ADJUST',
        'WASTE',
        'RECALL',
      ],
      required: true,
    },
    source: {
      type: new Schema({ type: text(60, true), id: { type: String, required: true } }, value),
      required: true,
    },
    operationKey: text(200, true),
    occurredAt: { type: Date, required: true },
    unitCostMinor: { type: Number, default: 0, min: 0 },
    pairedMovementId: ref('StockMovement', false),
    note: text(1000),
    createdBy: { type: actorSchema, required: true },
    schemaVersion: { type: Number, default: 1 },
  },
  appendOnly,
);
movementSchema.index({ organizationId: 1, operationKey: 1 }, { unique: true });
movementSchema.index({ organizationId: 1, itemId: 1, batchId: 1, occurredAt: 1 });
movementSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany'],
  () => {
    throw new Error('Stock movements are append-only');
  },
);
export const StockMovement = model('StockMovement', movementSchema, 'stockMovements');

const purchaseOrderSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    number: text(40, true),
    supplierId: ref('Supplier'),
    destinationId: ref('FacilityLocation'),
    lines: {
      type: [
        new Schema(
          {
            line: { type: Number, required: true, min: 1 },
            itemId: ref('InventoryItem'),
            quantity: { ...quantity, min: 1 },
            unitCostMinor: { type: Number, required: true, min: 0 },
            receivedQuantity: { type: Number, default: 0, min: 0 },
          },
          value,
        ),
      ],
      validate: bounded(200),
    },
    status: {
      type: String,
      enum: ['DRAFT', 'APPROVED', 'ORDERED', 'PART_RECEIVED', 'RECEIVED', 'CANCELLED'],
      default: 'DRAFT',
    },
    approvedBy: ref('User', false),
    orderedAt: Date,
    cancelReason: text(1000),
  },
  aggregateOptions,
);
purchaseOrderSchema.index({ organizationId: 1, number: 1 }, { unique: true });
purchaseOrderSchema.index({ organizationId: 1, supplierId: 1, status: 1 });
export const PurchaseOrder = model('PurchaseOrder', purchaseOrderSchema, 'purchaseOrders');

const receiptSchema = new Schema(
  {
    organizationId: ref('Organization'),
    purchaseOrderId: ref('PurchaseOrder'),
    receiptNumber: text(40, true),
    supplierInvoiceNumber: text(60),
    receivedAt: { type: Date, required: true },
    receivedBy: ref('User'),
    lines: {
      type: [
        new Schema(
          {
            purchaseLine: { type: Number, required: true },
            batchId: ref('StockBatch'),
            accepted: { type: Number, required: true, min: 0 },
            rejected: { type: Number, required: true, min: 0 },
          },
          value,
        ),
      ],
      validate: bounded(200),
    },
    operationKey: text(200, true),
    createdBy: { type: actorSchema, required: true },
    schemaVersion: { type: Number, default: 1 },
  },
  appendOnly,
);
receiptSchema.index({ organizationId: 1, receiptNumber: 1 }, { unique: true });
receiptSchema.index({ organizationId: 1, operationKey: 1 }, { unique: true });
export const GoodsReceipt = model('GoodsReceipt', receiptSchema, 'goodsReceipts');

const dispenseSchema = new Schema(
  {
    ...metadataFields,
    organizationId: ref('Organization'),
    patientId: ref('Patient'),
    patientRegistrationId: ref('PatientRegistration'),
    prescriptionId: ref('Prescription'),
    pharmacyFacilityId: ref('Facility'),
    pharmacistId: ref('Practitioner'),
    status: {
      type: String,
      enum: ['COMPLETED', 'PART_RETURNED', 'RETURNED'],
      default: 'COMPLETED',
    },
    dispensedAt: { type: Date, required: true },
    items: {
      type: [
        new Schema(
          {
            line: { type: Number, required: true },
            prescriptionItemId: ref('PrescriptionItem'),
            inventoryItemId: ref('InventoryItem'),
            batchId: ref('StockBatch'),
            locationId: ref('FacilityLocation'),
            quantity: { ...quantity, min: 1 },
            returnedQuantity: { type: Number, default: 0, min: 0 },
            substitutionReason: text(1000),
          },
          value,
        ),
      ],
      validate: bounded(100),
    },
    allergyOverrideReason: text(1000),
    operationKey: text(200, true),
  },
  aggregateOptions,
);
dispenseSchema.index({ organizationId: 1, operationKey: 1 }, { unique: true });
dispenseSchema.index({ organizationId: 1, prescriptionId: 1, dispensedAt: -1 });
export const Dispense = model('Dispense', dispenseSchema, 'dispenses');
