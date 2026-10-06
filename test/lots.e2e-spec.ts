import { UnprocessableEntityException } from '@nestjs/common';
import { OrderStatus, Role } from '@prisma/client';
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActivityService } from '../src/activity/activity.service';
import { effectivePermissions } from '../src/auth/permissions';
import { AuthUser } from '../src/common/types/request-with-user.interface';
import { ImportsService } from '../src/imports/imports.service';
import { LotsService } from '../src/lots/lots.service';
import { PackingService } from '../src/packing/packing.service';
import { PickingService } from '../src/picking/picking.service';
import { ProductsService } from '../src/products/products.service';
import { StockService } from '../src/stock/stock.service';
import { PlanLimitsService } from '../src/tenancy/plan-limits.service';
import { UploadsService } from '../src/uploads/uploads.service';
import { createTestTenant, deleteTestTenant, scopedTo, testPrisma } from './support/tenancy';

describe('Lots and expiry (integration)', () => {
  const prisma = testPrisma();
  let tenantId: string;
  const scoped = <T extends object>(service: T) => scopedTo(service, () => tenantId);
  const activity = new ActivityService(prisma);
  const uploads = { deleteFile: () => undefined } as unknown as UploadsService;
  const stock = scoped(new StockService(prisma));
  const lots = scoped(new LotsService(prisma));
  const products = scoped(new ProductsService(prisma, uploads));
  const picking = scoped(new PickingService(prisma, activity, uploads, new PlanLimitsService(prisma)));
  const packing = scoped(new PackingService(prisma, activity, uploads));
  const imports = scoped(new ImportsService(prisma));

  let admin: AuthUser;
  let warehouseId: string;
  let otherWarehouseId: string;
  let productId: string;

  const operator = () => ({ operatorId: admin.id, operatorName: admin.name });
  const receive = (quantity: number, code: string, expiresAt?: string) =>
    stock.registerMovement({
      productId, warehouseId, type: 'purchase_receipt', quantity, ...operator(),
      lot: { code, expiresAt: expiresAt ? new Date(expiresAt) : undefined },
    });
  const lotBalances = async (warehouse = warehouseId) =>
    Object.fromEntries((await stock.productLocations(productId, warehouse)).lots.map((l) => [l.lot.code, l.quantity]));
  const lotIdOf = async (code: string) => (await prisma.lot.findFirstOrThrow({ where: { productId, code } })).id;

  beforeAll(async () => {
    tenantId = (await createTestTenant(prisma)).id;
    const [main, other] = await Promise.all([
      prisma.warehouse.create({ data: { tenantId, code: 'MAIN', name: 'Main' } }),
      prisma.warehouse.create({ data: { tenantId, code: 'OTHER', name: 'Other' } }),
    ]);
    warehouseId = main.id;
    otherWarehouseId = other.id;
    const user = await prisma.user.create({
      data: { tenantId, username: 'admin', email: 'a@lots.test', name: 'Admin', password: 'x', role: Role.admin },
    });
    admin = {
      id: user.id, sub: user.id, tenantId, username: 'admin', name: 'Admin',
      role: Role.admin, warehouseId: null, permissions: effectivePermissions(Role.admin),
    };
  });

  beforeEach(async () => {
    const product = await products.create({ code: `L-${randomUUID().slice(0, 6)}`, name: 'Leche', category: 'c', lotTracking: true });
    productId = product.id;
    await prisma.warehouseStock.createMany({
      data: [warehouseId, otherWarehouseId].map((warehouse) => ({ tenantId, productId, warehouseId: warehouse })),
    });
  });

  afterAll(async () => {
    await deleteTestTenant(prisma, tenantId);
    await prisma.$disconnect();
  });

  it('requires a lot on receipts and ships first-expired-first-out', async () => {
    await expect(
      stock.registerMovement({ productId, warehouseId, type: 'purchase_receipt', quantity: 1, ...operator() }),
    ).rejects.toMatchObject({ response: { error: 'LOT_REQUIRED' } });

    await receive(5, 'late', '2027-03-01');
    await receive(5, 'early', '2027-01-01');
    await receive(5, 'none');
    await receive(2, 'EARLY');
    await expect(receive(1, 'early', '2027-02-02')).rejects.toMatchObject({ response: { error: 'LOT_EXPIRY_MISMATCH' } });

    await stock.registerMovement({ productId, warehouseId, type: 'adjustment_decrease', quantity: 9, ...operator() });
    expect(await lotBalances()).toEqual({ LATE: 3, NONE: 5 });
  });

  it('records the lots of each pick and returns them when the order does not ship', async () => {
    await receive(4, 'A', '2027-01-01');
    await receive(4, 'B', '2027-02-01');
    const order = await picking.create({ reference: `R-${randomUUID().slice(0, 6)}`, client: 'C', warehouseId, items: [{ productId, quantity: 6 }] }, admin);
    const itemId = order.items[0].id;

    await picking.updateItem(order.id, itemId, 6, admin);
    expect(await lotBalances()).toEqual({ B: 2 });
    await picking.updateItem(order.id, itemId, 5, admin);
    expect(await lotBalances()).toEqual({ B: 3 });

    await picking.updateStatus(order.id, OrderStatus.cancelled, admin);
    expect(await lotBalances()).toEqual({ A: 4, B: 4 });
  });

  it('ships the earliest lots, returns the rest and traces the order', async () => {
    await receive(3, 'A', '2027-01-01');
    await receive(3, 'B', '2027-02-01');
    const order = await picking.create({ reference: `R-${randomUUID().slice(0, 6)}`, client: 'Tienda', warehouseId, items: [{ productId, quantity: 5 }] }, admin);
    await picking.updateItem(order.id, order.items[0].id, 5, admin);
    await picking.updateStatus(order.id, OrderStatus.in_progress, admin);
    await picking.updateStatus(order.id, OrderStatus.completed, admin);

    const pack = await packing.create({ pickingOrderId: order.id, reference: order.reference }, admin);
    await packing.updateItem(pack.id, pack.items[0].id, 3, admin);
    await packing.updateStatus(pack.id, OrderStatus.in_progress, admin);
    await packing.updateStatus(pack.id, OrderStatus.completed, admin);

    expect(await lotBalances()).toEqual({ B: 3 });
    const trace = await lots.trace(await lotIdOf('A'));
    expect(trace.orders).toEqual([expect.objectContaining({ reference: order.reference, client: 'Tienda', quantity: 3 })]);
    expect(trace.movements.map((m) => m.type)).toEqual(['order_shipment', 'purchase_receipt']);
  });

  it('moves lots between warehouses and lists the ones about to expire', async () => {
    await receive(5, 'SOON', new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10));
    await receive(5, 'FAR', '2030-01-01');
    await stock.transfer({ productId, fromWarehouseId: warehouseId, toWarehouseId: otherWarehouseId, quantity: 2, lotId: await lotIdOf('FAR'), ...operator() });

    expect(await lotBalances(otherWarehouseId)).toEqual({ FAR: 2 });
    const expiring = await lots.findAll({ productId, expiringWithinDays: 30, page: 1, limit: 10 });
    expect(expiring.data.map((lot) => lot.code)).toEqual(['SOON']);
  });

  it('locks lot tracking while there is stock and rejects lots on untracked products', async () => {
    await receive(1, 'X');
    await expect(products.update(productId, { lotTracking: false })).rejects.toBeInstanceOf(UnprocessableEntityException);

    const plain = await products.create({ code: `N-${randomUUID().slice(0, 6)}`, name: 'Sin lote', category: 'c' });
    await prisma.warehouseStock.create({ data: { tenantId, productId: plain.id, warehouseId } });
    await expect(
      stock.registerMovement({ productId: plain.id, warehouseId, type: 'purchase_receipt', quantity: 1, lot: { code: 'Z' }, ...operator() }),
    ).rejects.toMatchObject({ response: { error: 'PRODUCT_NOT_LOT_TRACKED' } });
  });

  it('follows the product strategy, then the tenant default', async () => {
    await prisma.lot.create({ data: { tenantId, productId, code: 'OLD', createdAt: new Date('2026-01-01') } });
    await prisma.lot.create({ data: { tenantId, productId, code: 'NEW', createdAt: new Date('2026-06-01') } });
    await receive(2, 'OLD');
    await receive(2, 'NEW', '2026-12-01');
    const decrease = () => stock.registerMovement({ productId, warehouseId, type: 'adjustment_decrease', quantity: 1, ...operator() });

    await prisma.tenant.update({ where: { id: tenantId }, data: { settings: { pickingStrategy: 'fifo' } } });
    await decrease();
    expect(await lotBalances()).toEqual({ NEW: 2, OLD: 1 });

    await products.update(productId, { pickingStrategy: 'lifo' });
    await decrease();
    expect(await lotBalances()).toEqual({ NEW: 1, OLD: 1 });
    expect((await stock.productLocations(productId, warehouseId)).pickingStrategy).toBe('lifo');
    await prisma.tenant.update({ where: { id: tenantId }, data: { settings: {} } });
  });

  it('imports opening balances with lots and expiry', async () => {
    const code = (await prisma.product.findUniqueOrThrow({ where: { id: productId } })).code;
    const csv = `warehouse,product,quantity,lot,expiresAt\nMAIN,${code},7,IMP-1,2028-05-01\nMAIN,${code},1,,\n`;
    const dry = await imports.run('stock', Buffer.from(csv), true, admin);
    expect(dry.errors.map((e) => e.line)).toEqual([3]);

    await imports.run('stock', Buffer.from(csv.split('\n').slice(0, 2).join('\n')), false, admin);
    expect(await lotBalances()).toEqual({ 'IMP-1': 7 });
  });
});
