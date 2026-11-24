import { randomUUID } from 'node:crypto';
import type { ClientSession, Types } from 'mongoose';
import type { z } from 'zod';
import type { CommandActor, Pagination } from '../../shared/domain/healthcare.js';
import { todayInIndia } from '../../shared/domain/healthcare.js';
import { command, conflict, transaction } from '../../shared/application/command.js';
import {
  actorRef,
  before,
  formatNumber,
  nextNumber,
  pageOf,
  scoped,
  serviceActor,
  type OperationActor,
} from '../../shared/application/scope.js';
import { stamp } from '../../shared/persistence/schema.js';
import { ApiError } from '../../utils/api-error.js';
import { isDuplicateKeyError } from '../../utils/mongo.js';
import { authorizeOrganization } from '../access/access.service.js';
import { requirePlatformPermission } from '../access/platform-access.js';
import { PERMISSIONS } from '../admin/auth/roles/permission.constants.js';
import { recordChange } from '../operations/operation.service.js';
import { ownPractitioner } from '../clinical/clinical.policy.js';
import { Allergy, Prescription, PrescriptionItem } from '../clinical/clinical.model.js';
import { FacilityLocation } from '../locations/location.model.js';
import { recordCharge } from '../billing/invoice.service.js';
import { ChargeItem } from '../billing/billing.model.js';
import {
  Dispense,
  DrugCatalogItem,
  GoodsReceipt,
  InventoryItem,
  PurchaseOrder,
  StockBalance,
  StockBatch,
  StockMovement,
  Supplier,
} from './pharmacy.model.js';
import type {
  adjustmentInput,
  batchActionInput,
  catalogSearch,
  dispenseInput,
  dispenseReturnInput,
  drugInput,
  goodsReceiptInput,
  inventoryItemInput,
  purchaseOrderActionInput,
  purchaseOrderInput,
  stockQuery,
  supplierInput,
  transferInput,
} from './pharmacy.validation.js';

const who = (actor: CommandActor) => ({ kind: 'USER' as const, id: actor.userId });
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type Movement = {
  organizationId: string | Types.ObjectId;
  itemId: Types.ObjectId | string;
  batchId: Types.ObjectId | string;
  locationId: Types.ObjectId | string;
  bucket: 'ON_HAND' | 'QUARANTINED';
  quantityDelta: number;
  reason:
    | 'RECEIVE'
    | 'RELEASE'
    | 'DISPENSE'
    | 'RETURN'
    | 'TRANSFER_OUT'
    | 'TRANSFER_IN'
    | 'ADJUST'
    | 'WASTE'
    | 'RECALL';
  source: { type: string; id: string };
  operationKey: string;
  unitCostMinor?: number;
  note?: string;
};

/**
 * Posts one immutable movement and applies it to the balance with a nonnegative predicate. A
 * concurrent dispense of the last unit fails here rather than producing negative stock.
 */
export async function moveStock(actor: OperationActor, movement: Movement, session: ClientSession) {
  const field = movement.bucket === 'ON_HAND' ? 'onHand' : 'quarantined';
  const key = {
    organizationId: movement.organizationId,
    itemId: movement.itemId,
    batchId: movement.batchId,
    locationId: movement.locationId,
  };
  if (movement.quantityDelta > 0) {
    await StockBalance.updateOne(
      key,
      {
        $inc: { [field]: movement.quantityDelta },
        $setOnInsert: { [field === 'onHand' ? 'quarantined' : 'onHand']: 0 },
      },
      { upsert: true, session },
    );
  } else {
    const result = await StockBalance.updateOne(
      { ...key, [field]: { $gte: -movement.quantityDelta } },
      { $inc: { [field]: movement.quantityDelta } },
      { session },
    );
    if (!result.modifiedCount)
      throw new ApiError(
        409,
        'Insufficient stock for this batch and location',
        undefined,
        'STOCK_UNAVAILABLE',
      );
  }
  const [row] = await StockMovement.create(
    [{ ...movement, occurredAt: new Date(), createdBy: actorRef(actor) }],
    { session },
  );
  return row!;
}

async function storeLocation(organizationId: string, locationId: string, session?: ClientSession) {
  const location = await FacilityLocation.findOne({
    _id: locationId,
    organizationId,
    kind: { $in: ['STORE', 'WARD'] },
    operationalStatus: { $ne: 'CLOSED' },
  }).session(session ?? null);
  if (!location) throw ApiError.notFound('Stock location is unavailable');
  return location;
}

// ── Catalog, items and suppliers ─────────────────────────────────────────────

export async function addDrug(actor: CommandActor, input: z.infer<typeof drugInput>, key: string) {
  await requirePlatformPermission(actor, PERMISSIONS.CATALOG_MANAGE);
  try {
    return await command(actor, 'platform', 'drug.create', key, input, async (session) => {
      const [row] = await DrugCatalogItem.create([{ ...stamp(actor.userId), ...input }], {
        session,
      });
      await recordChange(
        actor,
        {
          action: 'DrugCataloged',
          resourceType: 'drugCatalogItem',
          resourceId: String(row!._id),
          version: 0,
        },
        session,
      );
      return { id: String(row!._id), version: 0 };
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) conflict('This drug code and release already exist');
    throw error;
  }
}

export async function searchDrugs(query: z.infer<typeof catalogSearch>) {
  const rows = await DrugCatalogItem.find({
    status: 'ACTIVE',
    ...(query.q
      ? {
          $or: [
            { genericName: { $regex: escape(query.q), $options: 'i' } },
            { brandName: { $regex: escape(query.q), $options: 'i' } },
          ],
        }
      : {}),
    ...before(query.before),
  })
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean();
  return pageOf(rows, query.limit, (row) => ({
    id: String(row._id),
    system: row.system,
    code: row.code,
    genericName: row.genericName,
    brandName: row.brandName,
    form: row.form,
    strength: row.strength,
    routes: row.routes,
  }));
}

export async function createInventoryItem(
  actor: CommandActor,
  organizationId: string,
  input: z.infer<typeof inventoryItemInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'inventory.manage');
  try {
    return await command(
      actor,
      organizationId,
      'inventory-item.create',
      key,
      input,
      async (session) => {
        await scoped(actor, organizationId, 'inventory.manage', session);
        if (
          input.drugId &&
          !(await DrugCatalogItem.exists({ _id: input.drugId, status: 'ACTIVE' }).session(session))
        )
          throw ApiError.notFound('Drug is unavailable');
        const [row] = await InventoryItem.create(
          [{ ...stamp(actor.userId), organizationId, ...input }],
          { session },
        );
        await recordChange(
          actor,
          {
            organizationId,
            action: 'InventoryItemCreated',
            resourceType: 'inventoryItem',
            resourceId: String(row!._id),
            version: 0,
          },
          session,
        );
        return { id: String(row!._id), version: 0 };
      },
    );
  } catch (error) {
    if (isDuplicateKeyError(error)) conflict('This SKU already exists');
    throw error;
  }
}

export async function listInventoryItems(
  actor: CommandActor,
  organizationId: string,
  page: Pagination,
) {
  await authorizeOrganization(actor, organizationId, 'inventory.manage');
  const rows = await InventoryItem.find({ organizationId, ...before(page.before) })
    .sort({ _id: -1 })
    .limit(page.limit + 1)
    .lean();
  return pageOf(rows, page.limit, (row) => ({
    id: String(row._id),
    sku: row.sku,
    kind: row.kind,
    drugId: row.drugId ? String(row.drugId) : undefined,
    name: row.name,
    stockUnit: row.stockUnit,
    reorderPoint: row.reorderPoint,
    salePriceMinor: row.salePriceMinor,
    taxBasisPoints: row.taxBasisPoints,
    status: row.status,
    version: row.version,
  }));
}

export async function createSupplier(
  actor: CommandActor,
  organizationId: string,
  input: z.infer<typeof supplierInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'procurement.manage');
  try {
    return await command(actor, organizationId, 'supplier.create', key, input, async (session) => {
      await scoped(actor, organizationId, 'procurement.manage', session);
      const [row] = await Supplier.create([{ ...stamp(actor.userId), organizationId, ...input }], {
        session,
      });
      await recordChange(
        actor,
        {
          organizationId,
          action: 'SupplierCreated',
          resourceType: 'supplier',
          resourceId: String(row!._id),
          version: 0,
        },
        session,
      );
      return { id: String(row!._id), version: 0 };
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) conflict('This supplier code already exists');
    throw error;
  }
}

export async function listSuppliers(actor: CommandActor, organizationId: string, page: Pagination) {
  await authorizeOrganization(actor, organizationId, 'procurement.manage');
  const rows = await Supplier.find({ organizationId, ...before(page.before) })
    .sort({ _id: -1 })
    .limit(page.limit + 1)
    .lean();
  return pageOf(rows, page.limit, (row) => ({
    id: String(row._id),
    code: row.code,
    legalName: row.legalName,
    status: row.status,
    licenseIdentifiers: row.licenseIdentifiers,
    version: row.version,
  }));
}

// ── Procurement ──────────────────────────────────────────────────────────────

export async function createPurchaseOrder(
  actor: CommandActor,
  organizationId: string,
  input: z.infer<typeof purchaseOrderInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'procurement.manage');
  return command(actor, organizationId, 'purchase-order.create', key, input, async (session) => {
    await scoped(actor, organizationId, 'procurement.manage', session, { activeProvider: true });
    if (
      !(await Supplier.exists({ _id: input.supplierId, organizationId, status: 'ACTIVE' }).session(
        session,
      ))
    )
      throw ApiError.notFound('Supplier is unavailable');
    await storeLocation(organizationId, input.destinationId, session);
    const items = await InventoryItem.countDocuments({
      _id: { $in: input.lines.map((line) => line.itemId) },
      organizationId,
      status: 'ACTIVE',
    }).session(session);
    if (items !== new Set(input.lines.map((line) => line.itemId)).size)
      throw ApiError.notFound('An item is unavailable');
    const [order] = await PurchaseOrder.create(
      [
        {
          ...stamp(actor.userId),
          organizationId,
          number: formatNumber('PO', await nextNumber(organizationId, 'PURCHASE_ORDER', session)),
          supplierId: input.supplierId,
          destinationId: input.destinationId,
          lines: input.lines.map((line, index) => ({ ...line, line: index + 1 })),
        },
      ],
      { session },
    );
    await recordChange(
      actor,
      {
        organizationId,
        action: 'PurchaseOrderDrafted',
        resourceType: 'purchaseOrder',
        resourceId: String(order!._id),
        version: 0,
      },
      session,
    );
    return { id: String(order!._id), version: 0 };
  });
}

/** Approval needs a second person; ordered lines are then fixed. */
export async function actOnPurchaseOrder(
  actor: CommandActor,
  organizationId: string,
  orderId: string,
  input: z.infer<typeof purchaseOrderActionInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'procurement.manage');
  return command(
    actor,
    organizationId,
    `purchase-order.${input.action}:${orderId}`,
    key,
    input,
    async (session) => {
      await scoped(actor, organizationId, 'procurement.manage', session);
      const order = await PurchaseOrder.findOne({
        _id: orderId,
        organizationId,
        version: input.expectedVersion,
      }).session(session);
      if (!order) conflict();
      if (input.action === 'approve') {
        if (order.status !== 'DRAFT') conflict('Only drafts can be approved');
        if (order.createdBy.id === actor.userId)
          throw ApiError.forbidden('A different staff member must approve');
        order.status = 'APPROVED';
        order.set('approvedBy', actor.userId);
      } else if (input.action === 'order') {
        if (order.status !== 'APPROVED') conflict('Approve the order first');
        order.status = 'ORDERED';
        order.orderedAt = new Date();
      } else {
        if (!['DRAFT', 'APPROVED', 'ORDERED'].includes(order.status))
          conflict('Received orders cannot be cancelled');
        if (!input.reason) throw ApiError.badRequest('A cancellation reason is required');
        order.status = 'CANCELLED';
        order.cancelReason = input.reason;
      }
      order.updatedBy = who(actor);
      await order.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          action: `PurchaseOrder.${input.action}`,
          resourceType: 'purchaseOrder',
          resourceId: orderId,
          version: order.version,
          reason: input.reason,
        },
        session,
      );
      return { id: orderId, version: order.version };
    },
  );
}

/** Received goods enter quarantine; release is a separate quality decision. */
export async function receiveGoods(
  actor: CommandActor,
  organizationId: string,
  orderId: string,
  input: z.infer<typeof goodsReceiptInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'procurement.manage');
  return command(actor, organizationId, `goods-receipt:${orderId}`, key, input, async (session) => {
    await scoped(actor, organizationId, 'procurement.manage', session);
    const order = await PurchaseOrder.findOne({
      _id: orderId,
      organizationId,
      version: input.expectedVersion,
    }).session(session);
    if (!order) conflict();
    if (!['ORDERED', 'PART_RECEIVED'].includes(order.status))
      conflict('Only ordered purchases can be received');
    const receiptNumber = formatNumber(
      'GRN',
      await nextNumber(organizationId, 'GOODS_RECEIPT', session),
    );
    const receiptLines = [];
    for (const received of input.lines) {
      const line = order.lines.find((entry) => entry.line === received.purchaseLine);
      if (!line) throw ApiError.badRequest(`Purchase line ${received.purchaseLine} does not exist`);
      if (line.receivedQuantity + received.accepted + received.rejected > line.quantity)
        throw new ApiError(409, 'Receipt exceeds the ordered quantity', undefined, 'OVER_RECEIPT');
      if (received.expiresOn <= todayInIndia())
        throw ApiError.badRequest('Expired goods cannot be received into stock');
      const existing = await StockBatch.findOne({
        organizationId,
        itemId: line.itemId,
        batchNumber: received.batchNumber,
        manufacturer: received.manufacturer,
      }).session(session);
      if (existing && existing.expiresOn !== received.expiresOn)
        throw ApiError.badRequest('Batch expiry differs from the recorded batch');
      const batch =
        existing ??
        (
          await StockBatch.create(
            [
              {
                ...stamp(actor.userId),
                organizationId,
                itemId: line.itemId,
                batchNumber: received.batchNumber,
                manufacturer: received.manufacturer,
                manufacturedOn: received.manufacturedOn,
                expiresOn: received.expiresOn,
                supplierId: order.supplierId,
              },
            ],
            { session },
          )
        )[0];
      if (received.accepted > 0)
        await moveStock(
          actor,
          {
            organizationId,
            itemId: line.itemId,
            batchId: batch!._id,
            locationId: order.destinationId,
            bucket: 'QUARANTINED',
            quantityDelta: received.accepted,
            reason: 'RECEIVE',
            source: { type: 'goodsReceipt', id: receiptNumber },
            operationKey: `receive:${receiptNumber}:${received.purchaseLine}`,
            unitCostMinor: line.unitCostMinor,
          },
          session,
        );
      line.receivedQuantity += received.accepted + received.rejected;
      receiptLines.push({
        purchaseLine: received.purchaseLine,
        batchId: batch!._id,
        accepted: received.accepted,
        rejected: received.rejected,
      });
    }
    order.status = order.lines.every((line) => line.receivedQuantity >= line.quantity)
      ? 'RECEIVED'
      : 'PART_RECEIVED';
    order.updatedBy = who(actor);
    await order.save({ session });
    const [receipt] = await GoodsReceipt.create(
      [
        {
          organizationId,
          purchaseOrderId: order._id,
          receiptNumber,
          supplierInvoiceNumber: input.supplierInvoiceNumber,
          receivedAt: new Date(),
          receivedBy: actor.userId,
          lines: receiptLines,
          operationKey: `${orderId}:${key}`,
          createdBy: who(actor),
        },
      ],
      { session },
    );
    await recordChange(
      actor,
      {
        organizationId,
        action: 'GoodsReceived',
        resourceType: 'goodsReceipt',
        resourceId: String(receipt!._id),
        version: 0,
      },
      session,
    );
    return { id: String(receipt!._id), version: 0 };
  });
}

/** Quality release moves quarantined stock to dispensable; a recall blocks the batch everywhere. */
export async function actOnBatch(
  actor: CommandActor,
  organizationId: string,
  batchId: string,
  input: z.infer<typeof batchActionInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'inventory.manage');
  return command(
    actor,
    organizationId,
    `batch.${input.action}:${batchId}`,
    key,
    input,
    async (session) => {
      await scoped(actor, organizationId, 'inventory.manage', session);
      await ownPractitioner(actor, session, ['PHARMACIST']);
      const batch = await StockBatch.findOne({
        _id: batchId,
        organizationId,
        version: input.expectedVersion,
      }).session(session);
      if (!batch) conflict();
      if (input.action === 'release') {
        if (batch.status !== 'QUARANTINED') conflict('Only quarantined batches can be released');
        if (batch.expiresOn <= todayInIndia()) conflict('Expired batches cannot be released');
        const balances = await StockBalance.find({
          organizationId,
          batchId,
          quarantined: { $gt: 0 },
        }).session(session);
        for (const balance of balances) {
          await moveStock(
            actor,
            {
              organizationId,
              itemId: balance.itemId,
              batchId,
              locationId: balance.locationId,
              bucket: 'QUARANTINED',
              quantityDelta: -balance.quarantined,
              reason: 'RELEASE',
              source: { type: 'stockBatch', id: batchId },
              operationKey: `release-out:${batchId}:${balance.locationId}:${key}`,
            },
            session,
          );
          await moveStock(
            actor,
            {
              organizationId,
              itemId: balance.itemId,
              batchId,
              locationId: balance.locationId,
              bucket: 'ON_HAND',
              quantityDelta: balance.quarantined,
              reason: 'RELEASE',
              source: { type: 'stockBatch', id: batchId },
              operationKey: `release-in:${batchId}:${balance.locationId}:${key}`,
            },
            session,
          );
        }
        batch.status = 'RELEASED';
      } else {
        if (!['QUARANTINED', 'RELEASED'].includes(batch.status))
          conflict('This batch cannot be recalled');
        batch.status = 'RECALLED';
      }
      batch.statusReason = input.reason;
      batch.updatedBy = who(actor);
      await batch.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          action: `StockBatch.${input.action}`,
          resourceType: 'stockBatch',
          resourceId: batchId,
          version: batch.version,
          reason: input.reason,
        },
        session,
      );
      return { id: batchId, version: batch.version };
    },
  );
}

export async function adjustStock(
  actor: CommandActor,
  organizationId: string,
  input: z.infer<typeof adjustmentInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'inventory.manage');
  return command(actor, organizationId, 'stock.adjust', key, input, async (session) => {
    await scoped(actor, organizationId, 'inventory.manage', session);
    const batch = await StockBatch.findOne({ _id: input.batchId, organizationId }).session(session);
    if (!batch) throw ApiError.notFound('Batch is unavailable');
    await storeLocation(organizationId, input.locationId, session);
    if (input.reason === 'WASTE' && input.quantityDelta > 0)
      throw ApiError.badRequest('Waste reduces stock');
    const movement = await moveStock(
      actor,
      {
        organizationId,
        itemId: batch.itemId,
        batchId: batch._id,
        locationId: input.locationId,
        bucket: 'ON_HAND',
        quantityDelta: input.quantityDelta,
        reason: input.reason,
        source: { type: 'adjustment', id: key },
        operationKey: `adjust:${key}`,
        note: input.note,
      },
      session,
    );
    await recordChange(
      actor,
      {
        organizationId,
        action: 'StockAdjusted',
        resourceType: 'stockMovement',
        resourceId: String(movement._id),
        version: 0,
        reason: input.note,
      },
      session,
    );
    return { id: String(movement._id), version: 0 };
  });
}

/** Transfers post a paired debit and credit in one transaction. */
export async function transferStock(
  actor: CommandActor,
  organizationId: string,
  input: z.infer<typeof transferInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'inventory.manage');
  if (input.fromLocationId === input.toLocationId)
    throw ApiError.badRequest('Choose two different locations');
  return command(actor, organizationId, 'stock.transfer', key, input, async (session) => {
    await scoped(actor, organizationId, 'inventory.manage', session);
    const batch = await StockBatch.findOne({
      _id: input.batchId,
      organizationId,
      status: { $in: ['QUARANTINED', 'RELEASED'] },
    }).session(session);
    if (!batch) throw ApiError.notFound('Batch is unavailable');
    await storeLocation(organizationId, input.fromLocationId, session);
    await storeLocation(organizationId, input.toLocationId, session);
    const base = {
      organizationId,
      itemId: batch.itemId,
      batchId: batch._id,
      bucket: 'ON_HAND' as const,
      source: { type: 'transfer', id: key },
    };
    const out = await moveStock(
      actor,
      {
        ...base,
        locationId: input.fromLocationId,
        quantityDelta: -input.quantity,
        reason: 'TRANSFER_OUT',
        operationKey: `transfer-out:${key}`,
      },
      session,
    );
    await moveStock(
      actor,
      {
        ...base,
        locationId: input.toLocationId,
        quantityDelta: input.quantity,
        reason: 'TRANSFER_IN',
        operationKey: `transfer-in:${key}`,
        note: `Paired with ${out._id}`,
      },
      session,
    );
    await recordChange(
      actor,
      {
        organizationId,
        action: 'StockTransferred',
        resourceType: 'stockMovement',
        resourceId: String(out._id),
        version: 0,
      },
      session,
    );
    return { id: String(out._id), version: 0 };
  });
}

export async function stockBalances(
  actor: CommandActor,
  organizationId: string,
  query: z.infer<typeof stockQuery>,
) {
  await authorizeOrganization(actor, organizationId, 'inventory.manage');
  const rows = await StockBalance.find({
    organizationId,
    ...(query.locationId ? { locationId: query.locationId } : {}),
    ...(query.itemId ? { itemId: query.itemId } : {}),
    $or: [{ onHand: { $gt: 0 } }, { quarantined: { $gt: 0 } }],
    ...before(query.before),
  })
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean();
  const batches = await StockBatch.find({ _id: { $in: rows.map((row) => row.batchId) } }).lean();
  const items = await InventoryItem.find({ _id: { $in: rows.map((row) => row.itemId) } }).lean();
  const batchById = new Map(batches.map((row) => [String(row._id), row]));
  const itemById = new Map(items.map((row) => [String(row._id), row]));
  const horizon = query.expiringWithinDays
    ? todayInIndia(new Date(Date.now() + query.expiringWithinDays * 86400_000))
    : undefined;
  const result = pageOf(rows, query.limit, (row) => {
    const batch = batchById.get(String(row.batchId));
    const item = itemById.get(String(row.itemId));
    return {
      itemId: String(row.itemId),
      sku: item?.sku,
      name: item?.name,
      unit: item?.stockUnit,
      batchId: String(row.batchId),
      batchNumber: batch?.batchNumber,
      expiresOn: batch?.expiresOn,
      batchStatus: batch?.status,
      locationId: String(row.locationId),
      onHand: row.onHand,
      quarantined: row.quarantined,
    };
  });
  if (horizon)
    result.items = result.items.filter((row) => row.expiresOn && row.expiresOn <= horizon);
  return result;
}

/** Items whose dispensable stock is at or below the reorder point. */
export async function lowStock(actor: CommandActor, organizationId: string) {
  const scope = await authorizeOrganization(actor, organizationId, 'inventory.manage');
  const totals = await StockBalance.aggregate<{ _id: Types.ObjectId; onHand: number }>([
    { $match: { organizationId: scope.organization._id } },
    { $group: { _id: '$itemId', onHand: { $sum: '$onHand' } } },
  ]);
  const byItem = new Map(totals.map((row) => [String(row._id), row.onHand]));
  const items = await InventoryItem.find({ organizationId, status: 'ACTIVE' }).lean();
  return items
    .map((item) => ({
      itemId: String(item._id),
      sku: item.sku,
      name: item.name,
      onHand: byItem.get(String(item._id)) ?? 0,
      reorderPoint: item.reorderPoint,
    }))
    .filter((row) => row.onHand <= row.reorderPoint);
}

// ── Dispensing ───────────────────────────────────────────────────────────────

/**
 * Finalizes a dispense: validates the signed prescription, remaining and refill quantity, batch
 * release and expiry, allergy review and nonnegative stock, then records movements and charges.
 * Any failure rolls back every effect.
 */
export async function dispense(
  actor: CommandActor,
  organizationId: string,
  input: z.infer<typeof dispenseInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'pharmacy.dispense', {
    facilityId: input.pharmacyFacilityId,
  });
  return command(
    actor,
    organizationId,
    `dispense:${input.prescriptionId}`,
    key,
    input,
    async (session) => {
      await scoped(actor, organizationId, 'pharmacy.dispense', session, {
        facilityId: input.pharmacyFacilityId,
        activeProvider: true,
      });
      const pharmacist = await ownPractitioner(actor, session, ['PHARMACIST']);
      const prescription = await Prescription.findOne({
        _id: input.prescriptionId,
        organizationId,
        status: 'SIGNED',
      }).session(session);
      if (!prescription) throw ApiError.notFound('A signed prescription is required');
      if (prescription.validUntil && prescription.validUntil < new Date())
        throw new ApiError(409, 'The prescription has expired', undefined, 'PRESCRIPTION_EXPIRED');
      const allergies = await Allergy.find({
        organizationId,
        patientId: prescription.patientId,
        category: 'DRUG',
        clinicalStatus: 'ACTIVE',
        verificationStatus: { $in: ['UNCONFIRMED', 'CONFIRMED'] },
      }).session(session);
      const today = todayInIndia();
      const lines = [];
      const warnings: string[] = [];
      for (const [index, line] of input.lines.entries()) {
        const item = await PrescriptionItem.findOne({
          _id: line.prescriptionItemId,
          prescriptionId: prescription._id,
          status: 'ACTIVE',
        }).session(session);
        if (!item) throw ApiError.notFound('An active prescription item is required');
        const inventory = await InventoryItem.findOne({
          _id: line.inventoryItemId,
          organizationId,
          status: 'ACTIVE',
        }).session(session);
        if (!inventory) throw ApiError.notFound('Inventory item is unavailable');
        const substituted = item.drugId && String(item.drugId) !== String(inventory.drugId);
        if (substituted && (!item.substitutionAllowed || !line.substitutionReason))
          throw new ApiError(
            409,
            'Substitution is not permitted or lacks a reason',
            undefined,
            'SUBSTITUTION_NOT_ALLOWED',
          );
        const batch = await StockBatch.findOne({
          _id: line.batchId,
          organizationId,
          itemId: inventory._id,
        }).session(session);
        if (!batch || batch.status !== 'RELEASED' || batch.expiresOn < today)
          throw new ApiError(
            409,
            'The batch is not released, is recalled or has expired',
            undefined,
            'BATCH_UNAVAILABLE',
          );
        const allowed = item.quantity.value * (1 + item.refillsAllowed);
        if (item.dispensedQuantity + line.quantity > allowed)
          throw new ApiError(
            409,
            'Quantity exceeds what remains on the prescription',
            undefined,
            'QUANTITY_EXCEEDED',
          );
        const medication = item.medication.name.toLowerCase();
        for (const allergy of allergies) {
          const substance = allergy.substance.text.toLowerCase();
          if (medication.includes(substance) || substance.includes(medication))
            warnings.push(`${item.medication.name} vs recorded allergy ${allergy.substance.text}`);
        }
        item.dispensedQuantity += line.quantity;
        if (item.dispensedQuantity >= allowed) item.status = 'COMPLETED';
        item.updatedBy = who(actor);
        await item.save({ session });
        lines.push({ ...line, line: index + 1, inventory, batch });
      }
      if (warnings.length && !input.allergyOverrideReason)
        throw new ApiError(
          409,
          'Possible allergy conflict requires pharmacist review',
          { warnings },
          'ALLERGY_REVIEW_REQUIRED',
        );
      const [record] = await Dispense.create(
        [
          {
            ...stamp(actor.userId),
            organizationId,
            patientId: prescription.patientId,
            patientRegistrationId: prescription.patientRegistrationId,
            prescriptionId: prescription._id,
            pharmacyFacilityId: input.pharmacyFacilityId,
            pharmacistId: pharmacist._id,
            dispensedAt: new Date(),
            items: lines.map(({ inventory: _inventory, batch: _batch, ...line }) => line),
            allergyOverrideReason: warnings.length ? input.allergyOverrideReason : undefined,
            operationKey: `${input.prescriptionId}:${key}`,
          },
        ],
        { session },
      );
      const dispenseId = String(record!._id);
      for (const line of lines) {
        await moveStock(
          actor,
          {
            organizationId,
            itemId: line.inventory._id,
            batchId: line.batch._id,
            locationId: line.locationId,
            bucket: 'ON_HAND',
            quantityDelta: -line.quantity,
            reason: 'DISPENSE',
            source: { type: 'dispense', id: dispenseId },
            operationKey: `dispense:${dispenseId}:${line.line}`,
          },
          session,
        );
        if (line.inventory.salePriceMinor > 0)
          await recordCharge(
            actor,
            {
              organizationId,
              patientId: String(prescription.patientId),
              patientRegistrationId: String(prescription.patientRegistrationId),
              facilityId: input.pharmacyFacilityId,
              source: { type: 'dispense', id: dispenseId },
              sourceLineKey: String(line.line),
              description: line.inventory.name,
              serviceCode: line.inventory.sku,
              quantity: line.quantity,
              unitPriceMinor: line.inventory.salePriceMinor,
              taxBasisPoints: line.inventory.taxBasisPoints,
            },
            session,
          );
      }
      await recordChange(
        actor,
        {
          organizationId,
          patientId: String(prescription.patientId),
          action: 'DispenseCompleted',
          resourceType: 'dispense',
          resourceId: dispenseId,
          version: 0,
        },
        session,
      );
      return { id: dispenseId, version: 0 };
    },
  );
}

/** Returned medicine goes to quarantine with provenance; it is never automatically saleable. */
export async function returnDispense(
  actor: CommandActor,
  organizationId: string,
  dispenseId: string,
  input: z.infer<typeof dispenseReturnInput>,
  key: string,
) {
  await authorizeOrganization(actor, organizationId, 'pharmacy.dispense');
  return command(
    actor,
    organizationId,
    `dispense.return:${dispenseId}`,
    key,
    input,
    async (session) => {
      const record = await Dispense.findOne({
        _id: dispenseId,
        organizationId,
        version: input.expectedVersion,
      }).session(session);
      if (!record) conflict();
      await scoped(actor, organizationId, 'pharmacy.dispense', session, {
        facilityId: String(record.pharmacyFacilityId),
      });
      await ownPractitioner(actor, session, ['PHARMACIST']);
      for (const returned of input.lines) {
        const line = record.items.find((entry) => entry.line === returned.line);
        if (!line) throw ApiError.badRequest(`Line ${returned.line} is not on this dispense`);
        if (line.returnedQuantity + returned.quantity > line.quantity)
          conflict('Return exceeds the dispensed quantity');
        line.returnedQuantity += returned.quantity;
        await moveStock(
          actor,
          {
            organizationId,
            itemId: line.inventoryItemId,
            batchId: line.batchId,
            locationId: line.locationId,
            bucket: 'QUARANTINED',
            quantityDelta: returned.quantity,
            reason: 'RETURN',
            source: { type: 'dispense', id: dispenseId },
            operationKey: `return:${dispenseId}:${returned.line}:${key}`,
            note: input.reason,
          },
          session,
        );
        const item = await PrescriptionItem.findById(line.prescriptionItemId).session(session);
        if (item) {
          item.dispensedQuantity -= returned.quantity;
          if (item.status === 'COMPLETED') item.status = 'ACTIVE';
          item.updatedBy = who(actor);
          await item.save({ session });
        }
        if (line.returnedQuantity === line.quantity)
          await ChargeItem.updateOne(
            {
              organizationId,
              'source.type': 'dispense',
              'source.id': dispenseId,
              sourceLineKey: String(line.line),
              status: 'UNBILLED',
            },
            { $set: { status: 'REVERSED' }, $inc: { version: 1 } },
            { session },
          );
      }
      record.status = record.items.every((line) => line.returnedQuantity === line.quantity)
        ? 'RETURNED'
        : 'PART_RETURNED';
      record.updatedBy = who(actor);
      await record.save({ session });
      await recordChange(
        actor,
        {
          organizationId,
          patientId: String(record.patientId),
          action: 'DispenseReturned',
          resourceType: 'dispense',
          resourceId: dispenseId,
          version: record.version,
          reason: input.reason,
        },
        session,
      );
      return { id: dispenseId, version: record.version };
    },
  );
}

/** Marks released batches past expiry as expired so they cannot be selected. */
export async function expireBatches(): Promise<number> {
  const today = todayInIndia();
  const candidates = await StockBatch.find({
    status: { $in: ['RELEASED', 'QUARANTINED'] },
    expiresOn: { $lt: today },
  }).limit(500);
  for (const batch of candidates)
    await transaction(async (session) => {
      const current = await StockBatch.findOne({ _id: batch._id, version: batch.version }).session(
        session,
      );
      if (!current) return;
      current.status = 'EXPIRED';
      current.statusReason = 'Past expiry date';
      current.updatedBy = { kind: 'SERVICE', id: 'batch-expiry' };
      await current.save({ session });
      await recordChange(
        serviceActor('batch-expiry', randomUUID()),
        {
          organizationId: String(current.organizationId),
          action: 'StockBatchExpired',
          resourceType: 'stockBatch',
          resourceId: String(current._id),
          version: current.version,
        },
        session,
      );
    });
  return candidates.length;
}
