import { LocationType, PurchaseOrderStatus, ReceiptStatus, Role } from '@prisma/client';
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { effectivePermissions } from '../src/auth/permissions';
import { AuthUser } from '../src/common/types/request-with-user.interface';
import { PurchaseOrdersService } from '../src/purchases/purchase-orders.service';
import { ReceiptsService } from '../src/receipts/receipts.service';
import { StockService } from '../src/stock/stock.service';
import { createTestTenant, deleteTestTenant, scopedTo, testPrisma } from './support/tenancy';

describe('Receiving (integration)', () => {
  const prisma = testPrisma();
  let tenantId: string;
  const scoped = <T extends object>(service: T) => scopedTo(service, () => tenantId);
  const receipts = scoped(new ReceiptsService(prisma));
  const orders = scoped(new PurchaseOrdersService(prisma));
  const stock = scoped(new StockService(prisma));

  let operator: AuthUser;
  let warehouseId: string;
  let supplierId: string;
  let plainId: string;
  let lotProductId: string;
  let binId: string;

  const newOrder = (items: { productId: string; quantity: number }[]) =>
    orders.create({ reference: `OC-${randomUUID().slice(0, 6)}`, supplierId, warehouseId, items }, { ...operator, permissions: effectivePermissions(Role.admin) });

  beforeAll(async () => {
    tenantId = (await createTestTenant(prisma)).id;
    const warehouse = await prisma.warehouse.create({ data: { tenantId, code: 'MAIN', name: 'Main' } });
    warehouseId = warehouse.id;
    const user = await prisma.user.create({
      data: { tenantId, username: 'op', email: 'op@rc.test', name: 'Operario', password: 'x', role: Role.operator, warehouseId },
    });
    operator = {
      id: user.id, sub: user.id, tenantId, username: 'op', name: 'Operario',
      role: Role.operator, warehouseId, permissions: effectivePermissions(Role.operator),
    };
    supplierId = (await prisma.partner.create({ data: { tenantId, code: 'SUP', name: 'Proveedor', isSupplier: true } })).id;
    plainId = (await prisma.product.create({ data: { tenantId, code: 'TOR', name: 'Tornillo', category: 'c' } })).id;
    lotProductId = (await prisma.product.create({ data: { tenantId, code: 'LEC', name: 'Leche', category: 'c', lotTracking: true } })).id;
    binId = (await prisma.location.create({ data: { tenantId, warehouseId, code: 'A-1', type: LocationType.bin, storable: true } })).id;
  });

  afterAll(async () => {
    await deleteTestTenant(prisma, tenantId);
    await prisma.$disconnect();
  });

  it('receives an order partially, then completely, posting stock with location and lot', async () => {
    const order = await newOrder([{ productId: plainId, quantity: 10 }, { productId: lotProductId, quantity: 4 }]);

    const first = await receipts.create({ purchaseOrderId: order.id }, operator);
    expect(first).toMatchObject({ warehouseId, supplier: { code: 'SUP' }, expected: expect.any(Array) });
    await receipts.addLine(first.id, { productId: plainId, quantity: 6, locationId: binId }, operator);
    await receipts.addLine(first.id, { productId: lotProductId, quantity: 4, lot: 'l-1', lotExpiresAt: '2027-01-01' }, operator);
    const partial = await receipts.complete(first.id, false, operator);

    expect(partial.receipt.status).toBe(ReceiptStatus.completed);
    expect(partial.differences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ productId: plainId, ordered: 10, received: 6, pending: 4 }),
        expect.objectContaining({ productId: lotProductId, ordered: 4, received: 4, pending: 0 }),
      ]),
    );
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(PurchaseOrderStatus.partially_received);
    expect(await stock.productLocations(plainId, warehouseId)).toMatchObject({ onHand: 6, locations: [{ quantity: 6 }] });
    expect(await stock.productLocations(lotProductId, warehouseId)).toMatchObject({ onHand: 4, lots: [{ lot: { code: 'L-1' }, quantity: 4 }] });

    const second = await receipts.create({ purchaseOrderId: order.id }, operator);
    const line = await receipts.addLine(second.id, { productId: plainId, quantity: 4 }, operator);
    expect(line.suggestedLocation).toMatchObject({ id: binId });
    await receipts.complete(second.id, false, operator);
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(PurchaseOrderStatus.received);
  });

  it('rejects over-receipts unless confirmed and products outside the order', async () => {
    const order = await newOrder([{ productId: plainId, quantity: 2 }]);
    const receipt = await receipts.create({ purchaseOrderId: order.id }, operator);
    await expect(receipts.addLine(receipt.id, { productId: lotProductId, quantity: 1, lot: 'X' }, operator)).rejects.toMatchObject({
      response: { error: 'PRODUCT_NOT_IN_ORDER' },
    });
    await receipts.addLine(receipt.id, { productId: plainId, quantity: 3 }, operator);

    await expect(receipts.complete(receipt.id, false, operator)).rejects.toMatchObject({ response: { error: 'OVER_RECEIPT' } });
    expect((await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } })).status).toBe(ReceiptStatus.open);

    const done = await receipts.complete(receipt.id, true, operator);
    expect(done.differences).toEqual([expect.objectContaining({ ordered: 2, received: 3, over: 1 })]);
  });

  it('receives blind, validates lots and refuses changes once completed', async () => {
    const receipt = await receipts.create({ warehouseId, supplierId }, operator);
    await expect(receipts.addLine(receipt.id, { productId: lotProductId, quantity: 1 }, operator)).rejects.toMatchObject({
      response: { error: 'LOT_REQUIRED' },
    });
    await expect(receipts.complete(receipt.id, false, operator)).rejects.toMatchObject({ response: { error: 'RECEIPT_EMPTY' } });

    const line = await receipts.addLine(receipt.id, { productId: plainId, quantity: 2 }, operator);
    const result = await receipts.complete(receipt.id, false, operator);
    expect(result.differences).toEqual([{ productId: plainId, ordered: null, received: 2, pending: 0, over: 0 }]);
    await expect(receipts.removeLine(receipt.id, line.id, operator)).rejects.toMatchObject({ response: { error: 'RECEIPT_INVALID_STATUS' } });
  });

  it('corrects a line before completing and filters by several statuses', async () => {
    const receipt = await receipts.create({ warehouseId }, operator);
    const line = await receipts.addLine(receipt.id, { productId: lotProductId, quantity: 1, lot: 'a' }, operator);
    const updated = await receipts.updateLine(receipt.id, line.id, { quantity: 3, locationId: binId, lot: 'b' }, operator);
    expect(updated).toMatchObject({ quantity: 3, lotCode: 'B', location: { id: binId } });
    expect((await receipts.updateLine(receipt.id, line.id, { locationId: null }, operator)).locationId).toBeNull();

    const open = await receipts.findAll({ status: [ReceiptStatus.open, ReceiptStatus.cancelled], page: 1, limit: 50 });
    expect(open.data.map((r) => r.id)).toContain(receipt.id);
    const completed = await receipts.findAll({ status: [ReceiptStatus.completed], page: 1, limit: 50 });
    expect(completed.data.map((r) => r.id)).not.toContain(receipt.id);
  });

  it('cancels open receipts without moving stock and blocks closed orders', async () => {
    const before = (await stock.productLocations(plainId, warehouseId)).onHand;
    const order = await newOrder([{ productId: plainId, quantity: 5 }]);
    const receipt = await receipts.create({ purchaseOrderId: order.id }, operator);
    await receipts.addLine(receipt.id, { productId: plainId, quantity: 5 }, operator);
    expect((await receipts.cancel(receipt.id, operator)).status).toBe(ReceiptStatus.cancelled);
    expect((await stock.productLocations(plainId, warehouseId)).onHand).toBe(before);

    await prisma.purchaseOrder.update({ where: { id: order.id }, data: { status: PurchaseOrderStatus.cancelled } });
    await expect(receipts.create({ purchaseOrderId: order.id }, operator)).rejects.toMatchObject({
      response: { error: 'PURCHASE_ORDER_INVALID_STATUS' },
    });
  });
});
