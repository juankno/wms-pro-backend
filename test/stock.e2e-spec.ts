import { BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/prisma/prisma.service';
import { StockService } from '../src/stock/stock.service';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error('TEST_DATABASE_URL must point to a disposable database');
}

describe('StockService (integration)', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const service = new StockService(prisma as PrismaService);
  const operator = { operatorId: '', operatorName: 'Test Operator' };

  let productId: string;
  let warehouseA: string;
  let warehouseB: string;

  const stockOf = (warehouseId: string) =>
    prisma.warehouseStock.findUnique({ where: { productId_warehouseId: { productId, warehouseId } } });

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);
    const user = await prisma.user.create({
      data: { username: `test-${suffix}`, email: `test-${suffix}@example.com`, name: operator.operatorName, password: 'unused' },
    });
    operator.operatorId = user.id;
  });

  beforeEach(async () => {
    const suffix = randomUUID().slice(0, 8);
    const [product, a, b] = await Promise.all([
      prisma.product.create({ data: { code: `TEST-${suffix}`, name: 'Test product', category: 'test' } }),
      prisma.warehouse.create({ data: { code: `WA-${suffix}`, name: 'Warehouse A' } }),
      prisma.warehouse.create({ data: { code: `WB-${suffix}`, name: 'Warehouse B' } }),
    ]);
    productId = product.id;
    warehouseA = a.id;
    warehouseB = b.id;
    await prisma.warehouseStock.create({ data: { productId, warehouseId: warehouseA, stockFisico: 5 } });
  });

  afterEach(async () => {
    await prisma.stockMovement.deleteMany({ where: { productId } });
    await prisma.warehouseStock.deleteMany({ where: { productId } });
    await prisma.product.delete({ where: { id: productId } });
    await prisma.warehouse.deleteMany({ where: { id: { in: [warehouseA, warehouseB] } } });
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: operator.operatorId } });
    await prisma.$disconnect();
  });

  describe('registerMovement', () => {
    it('increases physical stock and records before/after values', async () => {
      const { movement, stockActual } = await service.registerMovement({
        productId, warehouseId: warehouseA, type: 'ajuste_positivo', quantity: 3, ...operator,
      });

      expect(stockActual.stockFisico).toBe(8);
      expect(movement).toMatchObject({ stockFisicoAntes: 5, stockFisicoDespues: 8 });
    });

    it('rejects a negative adjustment above available stock without changing it', async () => {
      await expect(
        service.registerMovement({ productId, warehouseId: warehouseA, type: 'ajuste_negativo', quantity: 6, ...operator }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect((await stockOf(warehouseA))?.stockFisico).toBe(5);
    });

    it('never oversells under concurrent negative adjustments', async () => {
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () =>
          service.registerMovement({ productId, warehouseId: warehouseA, type: 'ajuste_negativo', quantity: 1, ...operator }),
        ),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
      expect((await stockOf(warehouseA))?.stockFisico).toBe(0);
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

      expect((await stockOf(warehouseA))?.stockFisico).toBe(3);
      expect((await stockOf(warehouseB))?.stockFisico).toBe(2);
      expect(movements.map((m) => m.type)).toEqual(['salida_traslado', 'entrada_traslado']);
    });

    it('preserves total stock under concurrent opposite transfers', async () => {
      await prisma.warehouseStock.create({ data: { productId, warehouseId: warehouseB, stockFisico: 5 } });

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
      expect(a!.stockFisico + b!.stockFisico).toBe(10);
    });
  });

  it('enforces non-negative stock at the database level', async () => {
    await expect(
      prisma.warehouseStock.update({
        where: { productId_warehouseId: { productId, warehouseId: warehouseA } },
        data: { stockFisico: -1 },
      }),
    ).rejects.toThrow();
  });
});
