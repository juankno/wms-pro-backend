import { OrderStatus, Role, SalesOrderStatus } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActivityService } from '../src/activity/activity.service';
import { effectivePermissions } from '../src/auth/permissions';
import { AuthUser } from '../src/common/types/request-with-user.interface';
import { PackingService } from '../src/packing/packing.service';
import { PickingService } from '../src/picking/picking.service';
import { SalesOrdersService } from '../src/sales/sales-orders.service';
import { PlanLimitsService } from '../src/tenancy/plan-limits.service';
import { UploadsService } from '../src/uploads/uploads.service';
import { createTestTenant, deleteTestTenant, scopedTo, testPrisma } from './support/tenancy';

describe('Sales orders (integration)', () => {
  const prisma = testPrisma();
  let tenantId: string;
  const scoped = <T extends object>(service: T) => scopedTo(service, () => tenantId);
  const activity = new ActivityService(prisma);
  const uploads = { deleteFile: () => undefined } as unknown as UploadsService;
  const pickingService = new PickingService(prisma, activity, uploads, new PlanLimitsService(prisma));
  const picking = scoped(pickingService);
  const packing = scoped(new PackingService(prisma, activity, uploads));
  const sales = scoped(new SalesOrdersService(prisma, pickingService, new PlanLimitsService(prisma)));

  let admin: AuthUser;
  let warehouseId: string;
  let customerId: string;
  let productA: string;
  let productB: string;

  const itemsOf = async (id: string) =>
    Object.fromEntries(
      (await prisma.salesOrderItem.findMany({ where: { salesOrderId: id }, include: { product: true } })).map((item) => [
        item.product.code,
        [item.quantity, item.releasedQuantity, item.shippedQuantity],
      ]),
    );
  const statusOf = async (id: string) => (await prisma.salesOrder.findUniqueOrThrow({ where: { id } })).status;

  const ship = async (pickingId: string, packed: Record<string, number>) => {
    const order = await prisma.pickingOrder.findUniqueOrThrow({ where: { id: pickingId }, include: { items: true } });
    for (const item of order.items) await picking.updateItem(order.id, item.id, item.quantity, admin);
    await picking.updateStatus(order.id, OrderStatus.in_progress, admin);
    await picking.updateStatus(order.id, OrderStatus.completed, admin);
    const pack = await packing.create({ pickingOrderId: order.id }, admin);
    for (const item of pack.items) await packing.updateItem(pack.id, item.id, packed[item.productId] ?? item.quantity, admin);
    await packing.updateStatus(pack.id, OrderStatus.in_progress, admin);
    await packing.updateStatus(pack.id, OrderStatus.completed, admin);
  };

  beforeAll(async () => {
    tenantId = (await createTestTenant(prisma)).id;
    warehouseId = (await prisma.warehouse.create({ data: { tenantId, code: 'W', name: 'W' } })).id;
    const user = await prisma.user.create({
      data: { tenantId, username: 'admin', email: 'a@so.test', name: 'Admin', password: 'x', role: Role.admin },
    });
    admin = {
      id: user.id, sub: user.id, tenantId, username: 'admin', name: 'Admin',
      role: Role.admin, warehouseId: null, permissions: effectivePermissions(Role.admin),
    };
    customerId = (await prisma.partner.create({ data: { tenantId, code: 'CLI', name: 'Tienda Uno', isCustomer: true } })).id;
    [productA, productB] = (
      await Promise.all(['A', 'B'].map((code) => prisma.product.create({ data: { tenantId, code, name: code, category: 'c' } })))
    ).map((product) => product.id);
  });

  beforeEach(async () => {
    await prisma.warehouseStock.deleteMany({ where: { tenantId } });
    await prisma.warehouseStock.createMany({
      data: [
        { tenantId, productId: productA, warehouseId, onHand: 10 },
        { tenantId, productId: productB, warehouseId, onHand: 3 },
      ],
    });
  });

  afterAll(async () => {
    await deleteTestTenant(prisma, tenantId);
    await prisma.$disconnect();
  });

  const newOrder = () =>
    sales.create({ customerId, warehouseId, items: [{ productId: productA, quantity: 4 }, { productId: productB, quantity: 5 }] }, admin);

  it('creates orders with a generated reference and the customer name', async () => {
    const order = await newOrder();
    expect(order).toMatchObject({ reference: expect.stringMatching(/^PV-\d{5}$/), client: 'Tienda Uno', status: SalesOrderStatus.open });
  });

  it('refuses a full release without stock and releases partially when allowed', async () => {
    const order = await newOrder();
    await expect(sales.release(order.id, {}, admin)).rejects.toMatchObject({
      response: { error: 'INSUFFICIENT_STOCK', details: [{ productId: productB, requested: 5, available: 3 }] },
    });

    const { salesOrder, pickingOrder } = await sales.release(order.id, { allowPartial: true }, admin);
    expect(salesOrder.status).toBe(SalesOrderStatus.partially_released);
    expect(pickingOrder).toMatchObject({ salesOrderId: order.id, client: 'Tienda Uno', reference: expect.stringMatching(/^PK-/) });
    expect(await itemsOf(order.id)).toEqual({ A: [4, 4, 0], B: [5, 3, 0] });
    expect((await prisma.warehouseStock.findFirstOrThrow({ where: { productId: productB } })).reserved).toBe(3);
  });

  it('tracks shipping and lets unshipped units be released again', async () => {
    const order = await newOrder();
    const first = await sales.release(order.id, { allowPartial: true }, admin);
    await ship(first.pickingOrder.id, { [productA]: 4, [productB]: 2 });

    expect(await itemsOf(order.id)).toEqual({ A: [4, 4, 4], B: [5, 2, 2] });
    expect(await statusOf(order.id)).toBe(SalesOrderStatus.partially_shipped);

    await prisma.warehouseStock.updateMany({ where: { productId: productB }, data: { onHand: { increment: 10 } } });
    const second = await sales.release(order.id, {}, admin);
    expect(second.pickingOrder.items.map((item) => [item.productId, item.quantity])).toEqual([[productB, 3]]);
    await ship(second.pickingOrder.id, {});
    expect(await statusOf(order.id)).toBe(SalesOrderStatus.shipped);
  });

  it('returns cancelled picking quantities and only cancels orders without picking in progress', async () => {
    const order = await newOrder();
    const { pickingOrder } = await sales.release(order.id, { allowPartial: true }, admin);
    await expect(sales.cancel(order.id, admin)).rejects.toMatchObject({ response: { error: 'SALES_ORDER_IN_PROGRESS' } });

    await picking.updateStatus(pickingOrder.id, OrderStatus.cancelled, admin);
    expect(await itemsOf(order.id)).toEqual({ A: [4, 0, 0], B: [5, 0, 0] });
    expect(await statusOf(order.id)).toBe(SalesOrderStatus.open);

    expect((await sales.cancel(order.id, admin)).status).toBe(SalesOrderStatus.cancelled);
    await expect(sales.release(order.id, {}, admin)).rejects.toMatchObject({ response: { error: 'SALES_ORDER_INVALID_STATUS' } });
  });
});
