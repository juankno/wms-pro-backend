import { ConflictException, ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { randomUUID } from 'crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActivityService } from '../src/activity/activity.service';
import { AuthUser } from '../src/common/types/request-with-user.interface';
import { PackingService } from '../src/packing/packing.service';
import { PickingService } from '../src/picking/picking.service';
import { UploadsService } from '../src/uploads/uploads.service';
import { PlanLimitsService } from '../src/tenancy/plan-limits.service';
import { createTestTenant, deleteTestTenant, scopedTo, testPrisma } from './support/tenancy';


describe('Picking and packing reservations (integration)', () => {
  const prisma = testPrisma();
  let tenantId: string;
  const activity = new ActivityService(prisma);
  const uploads = { deleteFile: () => undefined } as unknown as UploadsService;
  const picking = scopedTo(new PickingService(prisma, activity, uploads, new PlanLimitsService(prisma)), () => tenantId);
  const packing = scopedTo(new PackingService(prisma, activity, uploads), () => tenantId);

  let admin: AuthUser;
  let outsider: AuthUser;
  let warehouseId: string;
  let otherWarehouseId: string;
  let productA: string;
  let productB: string;

  const ref = () => `T-${randomUUID().slice(0, 8)}`;
  const stockOf = (productId: string) =>
    prisma.warehouseStock.findUniqueOrThrow({ where: { productId_warehouseId: { productId, warehouseId } } });
  const newPicking = (items: { productId: string; quantity: number }[]) =>
    picking.create({ reference: ref(), client: 'Client', warehouseId, items }, admin);

  beforeAll(async () => {
    tenantId = (await createTestTenant(prisma)).id;
    const suffix = randomUUID().slice(0, 8);
    const [w1, w2] = await Promise.all([
      prisma.warehouse.create({ data: { tenantId, code: `W1-${suffix}`, name: 'Main' } }),
      prisma.warehouse.create({ data: { tenantId, code: `W2-${suffix}`, name: 'Other' } }),
    ]);
    warehouseId = w1.id;
    otherWarehouseId = w2.id;

    const createUser = (name: string, role: Role, warehouse: string) =>
      prisma.user.create({
        data: { tenantId, username: `${name}-${suffix}`, email: `${name}-${suffix}@example.com`, name, role, password: 'unused', warehouseId: warehouse },
      });
    const [adminRow, outsiderRow] = await Promise.all([
      createUser('admin', Role.admin, warehouseId),
      createUser('outsider', Role.operator, otherWarehouseId),
    ]);
    const toAuthUser = (u: typeof adminRow): AuthUser => ({
      id: u.id, sub: u.id, tenantId, name: u.name, username: u.username, role: u.role, warehouseId: u.warehouseId,
    });
    admin = toAuthUser(adminRow);
    outsider = toAuthUser(outsiderRow);
  });

  beforeEach(async () => {
    const suffix = randomUUID().slice(0, 8);
    const [a, b] = await Promise.all([
      prisma.product.create({ data: { tenantId, code: `PA-${suffix}`, name: 'Product A', category: 'test' } }),
      prisma.product.create({ data: { tenantId, code: `PB-${suffix}`, name: 'Product B', category: 'test' } }),
    ]);
    productA = a.id;
    productB = b.id;
    await prisma.warehouseStock.createMany({
      data: [
        { tenantId, productId: productA, warehouseId, onHand: 10 },
        { tenantId, productId: productB, warehouseId, onHand: 5 },
      ],
    });
  });

  afterEach(async () => {
    const productIds = [productA, productB];
    const orders = await prisma.pickingOrder.findMany({
      where: { items: { some: { productId: { in: productIds } } } },
      select: { id: true, packingOrder: { select: { id: true } } },
    });
    const orderIds = orders.flatMap((o) => [o.id, ...(o.packingOrder ? [o.packingOrder.id] : [])]);
    await prisma.activityLog.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.packingOrder.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.pickingOrder.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.stockMovement.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.warehouseStock.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
  });

  afterAll(async () => {
    await deleteTestTenant(prisma, tenantId);
    await prisma.$disconnect();
  });

  describe('picking', () => {
    it('reserves stock on creation and logs the activity in the same transaction', async () => {
      const order = await newPicking([{ productId: productA, quantity: 4 }]);

      expect((await stockOf(productA)).reserved).toBe(4);
      expect(order.items[0].reservedQuantity).toBe(4);
      expect(await prisma.activityLog.count({ where: { orderId: order.id, action: 'created' } })).toBe(1);
    });

    it('rejects an order above available stock without reserving anything', async () => {
      await expect(
        newPicking([
          { productId: productA, quantity: 2 },
          { productId: productB, quantity: 6 },
        ]),
      ).rejects.toBeInstanceOf(ConflictException);

      expect((await stockOf(productA)).reserved).toBe(0);
    });

    it('never oversells under concurrent order creation', async () => {
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => newPicking([{ productId: productA, quantity: 3 }])),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
      expect((await stockOf(productA)).reserved).toBe(9);
    });

    it('refuses to complete an order with nothing picked', async () => {
      const order = await newPicking([{ productId: productA, quantity: 2 }]);
      await picking.updateStatus(order.id, 'in_progress', admin);

      await expect(picking.updateStatus(order.id, 'completed', admin)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });

    it('rejects picking more than requested', async () => {
      const order = await newPicking([{ productId: productA, quantity: 2 }]);

      await expect(picking.updateItem(order.id, order.items[0].id, 3, admin)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });

    it('releases the unpicked quantity on completion', async () => {
      const order = await newPicking([{ productId: productA, quantity: 4 }]);
      await picking.updateStatus(order.id, 'in_progress', admin);
      await picking.updateItem(order.id, order.items[0].id, 3, admin);
      await picking.updateStatus(order.id, 'completed', admin);

      expect((await stockOf(productA)).reserved).toBe(3);
    });

    it('releases every reservation on cancellation and on deletion', async () => {
      const cancelled = await newPicking([{ productId: productA, quantity: 4 }]);
      const deleted = await newPicking([{ productId: productB, quantity: 2 }]);

      await picking.updateStatus(cancelled.id, 'cancelled', admin);
      await picking.delete(deleted.id, admin);

      expect((await stockOf(productA)).reserved).toBe(0);
      expect((await stockOf(productB)).reserved).toBe(0);
    });

    it('filters the listing by priority', async () => {
      const urgent = await picking.create(
        { reference: ref(), client: 'Client', warehouseId, priority: 'high', items: [{ productId: productA, quantity: 1 }] },
        admin,
      );
      await newPicking([{ productId: productA, quantity: 1 }]);

      const { data } = await picking.findAll({ warehouseId, priority: 'high', page: 1, limit: 20 });

      expect(data.map((o) => o.id)).toEqual([urgent.id]);
    });

    it('hides orders from users of other warehouses', async () => {
      const order = await newPicking([{ productId: productA, quantity: 1 }]);

      await expect(picking.findById(order.id, outsider)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('packing', () => {
    const pickAndComplete = async (quantity: number, picked: number) => {
      const order = await newPicking([{ productId: productA, quantity }]);
      await picking.updateStatus(order.id, 'in_progress', admin);
      await picking.updateItem(order.id, order.items[0].id, picked, admin);
      await picking.updateStatus(order.id, 'completed', admin);
      return packing.create({ pickingOrderId: order.id, reference: ref() }, admin);
    };

    it('ships packed units and releases the rest of the reservation', async () => {
      const order = await pickAndComplete(4, 3);
      await packing.updateStatus(order.id, 'in_progress', admin);
      await packing.updateItem(order.id, order.items[0].id, 2, admin);
      await packing.updateStatus(order.id, 'completed', admin);

      const stock = await stockOf(productA);
      expect(stock).toMatchObject({ onHand: 8, reserved: 0 });

      const movements = await prisma.stockMovement.findMany({ where: { productId: productA } });
      expect(movements).toHaveLength(1);
      expect(movements[0]).toMatchObject({ type: 'order_shipment', quantity: 2, onHandBefore: 10, onHandAfter: 8 });
    });

    it('refuses to complete a packing with nothing packed', async () => {
      const order = await pickAndComplete(2, 2);
      await packing.updateStatus(order.id, 'in_progress', admin);

      await expect(packing.updateStatus(order.id, 'completed', admin)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });

    it('releases the reservation when cancelled without touching physical stock', async () => {
      const order = await pickAndComplete(4, 4);
      await packing.updateStatus(order.id, 'cancelled', admin);

      expect(await stockOf(productA)).toMatchObject({ onHand: 10, reserved: 0 });
    });
  });
});
