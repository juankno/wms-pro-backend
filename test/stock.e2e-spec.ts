import { BadRequestException, ConflictException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { StockService } from '../src/stock/stock.service';
import { createTestTenant, deleteTestTenant, scopedTo, testPrisma } from './support/tenancy';


describe('StockService (integration)', () => {
  const prisma = testPrisma();
  let tenantId: string;
  const service = scopedTo(new StockService(prisma), () => tenantId);
  const operator = { operatorId: '', operatorName: 'Test Operator' };

  let productId: string;
  let warehouseA: string;
  let warehouseB: string;

  const stockOf = (warehouseId: string) =>
    prisma.warehouseStock.findUnique({ where: { productId_warehouseId: { productId, warehouseId } } });

  beforeAll(async () => {
    tenantId = (await createTestTenant(prisma)).id;
    const suffix = randomUUID().slice(0, 8);
    const user = await prisma.user.create({
      data: { tenantId, username: `test-${suffix}`, email: `test-${suffix}@example.com`, name: operator.operatorName, password: 'unused' },
    });
    operator.operatorId = user.id;
  });

  beforeEach(async () => {
    const suffix = randomUUID().slice(0, 8);
    const [product, a, b] = await Promise.all([
      prisma.product.create({ data: { tenantId, code: `TEST-${suffix}`, name: 'Test product', category: 'test' } }),
      prisma.warehouse.create({ data: { tenantId, code: `WA-${suffix}`, name: 'Warehouse A' } }),
      prisma.warehouse.create({ data: { tenantId, code: `WB-${suffix}`, name: 'Warehouse B' } }),
    ]);
    productId = product.id;
    warehouseA = a.id;
    warehouseB = b.id;
    await prisma.warehouseStock.create({ data: { tenantId, productId, warehouseId: warehouseA, onHand: 5 } });
  });

  afterEach(async () => {
    await prisma.stockMovement.deleteMany({ where: { productId } });
    await prisma.warehouseStock.deleteMany({ where: { productId } });
    await prisma.product.delete({ where: { id: productId } });
    await prisma.warehouse.deleteMany({ where: { id: { in: [warehouseA, warehouseB] } } });
  });

  afterAll(async () => {
    await deleteTestTenant(prisma, tenantId);
    await prisma.$disconnect();
  });

  describe('registerMovement', () => {
    it('increases physical stock and records before/after values', async () => {
      const { movement, stockActual } = await service.registerMovement({
        productId, warehouseId: warehouseA, type: 'adjustment_increase', quantity: 3, ...operator,
      });

      expect(stockActual.onHand).toBe(8);
      expect(movement).toMatchObject({ onHandBefore: 5, onHandAfter: 8 });
    });

    it('rejects a negative adjustment above available stock without changing it', async () => {
      await expect(
        service.registerMovement({ productId, warehouseId: warehouseA, type: 'adjustment_decrease', quantity: 6, ...operator }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect((await stockOf(warehouseA))?.onHand).toBe(5);
    });

    it('never oversells under concurrent negative adjustments', async () => {
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () =>
          service.registerMovement({ productId, warehouseId: warehouseA, type: 'adjustment_decrease', quantity: 1, ...operator }),
        ),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
      expect((await stockOf(warehouseA))?.onHand).toBe(0);
    });
  });

  describe('transfer', () => {
    it('rejects transfers within the same warehouse', async () => {
      await expect(
        service.transfer({ productId, fromWarehouseId: warehouseA, toWarehouseId: warehouseA, quantity: 1, ...operator }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('creates the destination stock row and moves the quantity', async () => {
      const { movements } = await service.transfer({
        productId, fromWarehouseId: warehouseA, toWarehouseId: warehouseB, quantity: 2, ...operator,
      });

      expect((await stockOf(warehouseA))?.onHand).toBe(3);
      expect((await stockOf(warehouseB))?.onHand).toBe(2);
      expect(movements.map((m) => m.type)).toEqual(['transfer_out', 'transfer_in']);
    });

    it('preserves total stock under concurrent opposite transfers', async () => {
      await prisma.warehouseStock.create({ data: { tenantId, productId, warehouseId: warehouseB, onHand: 5 } });

      const results = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) =>
          service.transfer({
            productId,
            fromWarehouseId: i % 2 ? warehouseA : warehouseB,
            toWarehouseId: i % 2 ? warehouseB : warehouseA,
            quantity: 1,
            ...operator,
          }),
        ),
      );

      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      const [a, b] = await Promise.all([stockOf(warehouseA), stockOf(warehouseB)]);
      expect(a!.onHand + b!.onHand).toBe(10);
    });
  });

  it('enforces non-negative stock at the database level', async () => {
    await expect(
      prisma.warehouseStock.update({
        where: { productId_warehouseId: { productId, warehouseId: warehouseA } },
        data: { onHand: -1 },
      }),
    ).rejects.toThrow();
  });
});
