import { Router, type Request } from 'express';
import { protect } from '../admin/auth/auth.middleware.js';
import { actor, idempotencyKey } from '../../shared/http/context.js';
import { idParam, noStore, ok, pageQuery } from '../../shared/http/handler.js';
import * as pharmacy from './pharmacy.service.js';
import * as dto from './pharmacy.validation.js';

const router = Router();
const org = '/organizations/:organizationId';
const orgId = (req: Request) => idParam(req, 'organizationId');

router.get(
  '/drugs',
  noStore(async (req) => pharmacy.searchDrugs(dto.catalogSearch.parse(req.query))),
);
router.post(
  '/platform/drugs',
  protect,
  ok(
    (req) => pharmacy.addDrug(actor(req), dto.drugInput.parse(req.body), idempotencyKey(req)),
    201,
  ),
);

router.post(
  `${org}/inventory-items`,
  protect,
  ok(
    (req) =>
      pharmacy.createInventoryItem(
        actor(req),
        orgId(req),
        dto.inventoryItemInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.get(
  `${org}/inventory-items`,
  protect,
  noStore((req) => pharmacy.listInventoryItems(actor(req), orgId(req), pageQuery(req))),
);
router.post(
  `${org}/suppliers`,
  protect,
  ok(
    (req) =>
      pharmacy.createSupplier(
        actor(req),
        orgId(req),
        dto.supplierInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.get(
  `${org}/suppliers`,
  protect,
  noStore((req) => pharmacy.listSuppliers(actor(req), orgId(req), pageQuery(req))),
);
router.post(
  `${org}/purchase-orders`,
  protect,
  ok(
    (req) =>
      pharmacy.createPurchaseOrder(
        actor(req),
        orgId(req),
        dto.purchaseOrderInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.post(
  `${org}/purchase-orders/:orderId/transition`,
  protect,
  ok((req) =>
    pharmacy.actOnPurchaseOrder(
      actor(req),
      orgId(req),
      idParam(req, 'orderId'),
      dto.purchaseOrderActionInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);
router.post(
  `${org}/purchase-orders/:orderId/receipts`,
  protect,
  ok(
    (req) =>
      pharmacy.receiveGoods(
        actor(req),
        orgId(req),
        idParam(req, 'orderId'),
        dto.goodsReceiptInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.post(
  `${org}/stock-batches/:batchId/transition`,
  protect,
  ok((req) =>
    pharmacy.actOnBatch(
      actor(req),
      orgId(req),
      idParam(req, 'batchId'),
      dto.batchActionInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);
router.post(
  `${org}/stock-adjustments`,
  protect,
  ok(
    (req) =>
      pharmacy.adjustStock(
        actor(req),
        orgId(req),
        dto.adjustmentInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.post(
  `${org}/stock-transfers`,
  protect,
  ok(
    (req) =>
      pharmacy.transferStock(
        actor(req),
        orgId(req),
        dto.transferInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.get(
  `${org}/stock`,
  protect,
  noStore((req) => pharmacy.stockBalances(actor(req), orgId(req), dto.stockQuery.parse(req.query))),
);
router.get(
  `${org}/stock/low`,
  protect,
  noStore((req) => pharmacy.lowStock(actor(req), orgId(req))),
);
router.post(
  `${org}/dispenses`,
  protect,
  ok(
    (req) =>
      pharmacy.dispense(
        actor(req),
        orgId(req),
        dto.dispenseInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.post(
  `${org}/dispenses/:dispenseId/returns`,
  protect,
  ok((req) =>
    pharmacy.returnDispense(
      actor(req),
      orgId(req),
      idParam(req, 'dispenseId'),
      dto.dispenseReturnInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);

export default router;
