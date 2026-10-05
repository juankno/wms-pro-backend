import { OrderStatus, ReceiptKind, ReturnDisposition, Role } from '@prisma/client';
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActivityService } from '../src/activity/activity.service';
import { effectivePermissions } from '../src/auth/permissions';
import { AuthUser } from '../src/common/types/request-with-user.interface';
import { PackingService } from '../src/packing/packing.service';
import { PickingService } from '../src/picking/picking.service';
import { ReceiptsService } from '../src/receipts/receipts.service';
import { StockService } from '../src/stock/stock.service';
import { PlanLimitsService } from '../src/tenancy/plan-limits.service';
import { UploadsService } from '../src/uploads/uploads.service';
import { createTestTenant, deleteTestTenant, scopedTo, testPrisma } from './support/tenancy';

describe('Customer returns (integration)', () => {
  const prisma = testPrisma();
  let tenantId: string;
  const scoped = <T extends object>(service: T) => scopedTo(service, () => tenantId);
  const activity = new ActivityService(prisma);
  const uploads = { deleteFile: () => undefined } as unknown as UploadsService;
  const receipts = scoped(new ReceiptsService(prisma));
  const stock = scoped(new StockService(prisma));
  const picking = scoped(new PickingService(prisma, activity, uploads, new PlanLimitsService(prisma)));
  const packing = scoped(new PackingService(prisma, activity, uploads));

  let admin: AuthUser;
  let warehouseId: string;
  let customerId: string;
  let productId: string;

  const onHand = async () => (await stock.productLocations(productId, warehouseId)).onHand;

  const shipOrder = async (quantity: number) => {
    const order = await picking.create({ reference: `R-${randomUUID().slice(0, 6)}`, customerId, warehouseId, items: [{ productId, quantity }] }, admin);
    await picking.updateItem(order.id, order.items[0].id, quantity, admin);
    await picking.updateStatus(order.id, OrderStatus.in_progress, admin);
    await picking.updateStatus(order.id, OrderStatus.completed, admin);
    const pack = await packing.create({ pickingOrderId: order.id, reference: order.reference }, admin);
    await packing.updateItem(pack.id, pack.items[0].id, quantity, admin);
    await packing.updateStatus(pack.id, OrderStatus.in_progress, admin);
    await packing.updateStatus(pack.id, OrderStatus.completed, admin);
    return order;
  };

  beforeAll(async () => {
    tenantId = (await createTestTenant(prisma)).id;
    warehouseId = (await prisma.warehouse.create({ data: { tenantId, code: 'W', name: 'W' } })).id;
    const user = await prisma.user.create({
      data: { tenantId, username: 'admin', email: 'a@ret.test', name: 'Admin', password: 'x', role: Role.admin },
    });
    admin = {
      id: user.id, sub: user.id, tenantId, username: 'admin', name: 'Admin',
      role: Role.admin, warehouseId: null, permissions: effectivePermissions(Role.admin),
    };
    customerId = (await prisma.partner.create({ data: { tenantId, code: 'CLI', name: 'Cliente', isCustomer: true } })).id;
    productId = (await prisma.product.create({ data: { tenantId, code: 'P', name: 'Producto', category: 'c' } })).id;
    await prisma.warehouseStock.create({ data: { tenantId, productId, warehouseId, onHand: 20 } });
  });

  afterAll(async () => {
    await deleteTestTenant(prisma, tenantId);
    await prisma.$disconnect();
  });

  it('restocks returned units of a shipped order and discards the scrapped ones', async () => {
    const order = await shipOrder(5);
    expect(await onHand()).toBe(15);

    const ret = await receipts.create({ kind: ReceiptKind.customer_return, pickingOrderId: order.id }, admin);
    expect(ret).toMatchObject({ kind: ReceiptKind.customer_return, customer: { code: 'CLI' }, warehouseId });
    expect(ret.returnable).toEqual([expect.objectContaining({ shipped: 5, previouslyReturned: 0 })]);

    await receipts.addLine(ret.id, { productId, quantity: 3 }, admin);
    await receipts.addLine(ret.id, { productId, quantity: 1, disposition: ReturnDisposition.scrap }, admin);
    const done = await receipts.complete(ret.id, false, admin);

    expect(done.differences).toEqual([expect.objectContaining({ productId, received: 3, scrapped: 1 })]);
    expect(await onHand()).toBe(18);
    const movement = await prisma.stockMovement.findFirstOrThrow({ where: { referenceId: ret.id } });
    expect(movement).toMatchObject({ type: 'customer_return', quantity: 3, referenceType: 'return' });
  });

  it('limits returns to what the order shipped across receipts', async () => {
    const order = await shipOrder(2);
    const first = await receipts.create({ kind: ReceiptKind.customer_return, pickingOrderId: order.id }, admin);
    await receipts.addLine(first.id, { productId, quantity: 2 }, admin);

    const second = await receipts.create({ kind: ReceiptKind.customer_return, pickingOrderId: order.id }, admin);
    await expect(receipts.addLine(second.id, { productId, quantity: 1 }, admin)).rejects.toMatchObject({
      response: { error: 'RETURN_EXCEEDS_SHIPPED', details: { shipped: 2, returned: 2 } },
    });
  });

  it('accepts returns without an order and rejects orders not yet shipped', async () => {
    const free = await receipts.create({ kind: ReceiptKind.customer_return, customerId, warehouseId }, admin);
    await receipts.addLine(free.id, { productId, quantity: 1 }, admin);
    await receipts.complete(free.id, false, admin);

    const pending = await picking.create({ reference: `R-${randomUUID().slice(0, 6)}`, customerId, warehouseId, items: [{ productId, quantity: 1 }] }, admin);
    await expect(receipts.create({ kind: ReceiptKind.customer_return, pickingOrderId: pending.id }, admin)).rejects.toMatchObject({
      response: { error: 'ORDER_NOT_SHIPPED' },
    });
  });

  it('keeps scrap out of purchase receipts', async () => {
    const receipt = await receipts.create({ warehouseId }, admin);
    await expect(receipts.addLine(receipt.id, { productId, quantity: 1, disposition: ReturnDisposition.scrap }, admin)).rejects.toMatchObject({
      response: { error: 'DISPOSITION_NOT_ALLOWED' },
    });
  });
});
