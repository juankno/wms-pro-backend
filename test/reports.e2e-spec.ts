import { MovementType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProductsService } from '../src/products/products.service';
import { ReportsService } from '../src/reports/reports.service';
import { StockService } from '../src/stock/stock.service';
import { UploadsService } from '../src/uploads/uploads.service';
import { createTestTenant, deleteTestTenant, scopedTo, testPrisma } from './support/tenancy';


describe('Product listing and reports (integration)', () => {
  const prisma = testPrisma();
  let tenantId: string;
  const products = scopedTo(new ProductsService(prisma, {} as UploadsService), () => tenantId);
  const reports = scopedTo(new ReportsService(prisma), () => tenantId);
  const stock = scopedTo(new StockService(prisma), () => tenantId);
  const suffix = randomUUID().slice(0, 8);

  let warehouseId: string;
  let userId: string;
  const productIds: string[] = [];

  beforeAll(async () => {
    tenantId = (await createTestTenant(prisma)).id;
    warehouseId = (await prisma.warehouse.create({ data: { tenantId, code: `RW-${suffix}`, name: 'Reports' } })).id;
    userId = (
      await prisma.user.create({
        data: { tenantId, username: `rep-${suffix}`, email: `rep-${suffix}@example.com`, name: 'Reporter', password: 'unused' },
      })
    ).id;

    const stock = [
      { name: 'Out', onHand: 2, reserved: 2, minStock: 1 },
      { name: 'Low', onHand: 3, reserved: 0, minStock: 5 },
      { name: 'Ok', onHand: 10, reserved: 0, minStock: 2 },
      { name: 'Unstocked', onHand: null, reserved: 0, minStock: 0 },
    ];
    for (const [i, s] of stock.entries()) {
      const product = await prisma.product.create({
        data: { tenantId, code: `R${i}-${suffix}`, name: `${s.name} ${suffix}`, category: 'reports' },
      });
      productIds.push(product.id);
      if (s.onHand !== null) {
        await prisma.warehouseStock.create({
          data: { tenantId, productId: product.id, warehouseId, onHand: s.onHand, reserved: s.reserved, minStock: s.minStock },
        });
      }
    }

    const movement = (type: MovementType, quantity: number) => ({
      tenantId, productId: productIds[2], warehouseId, type, quantity, operatorId: userId, operatorName: 'Reporter',
      onHandBefore: 0, onHandAfter: 0, reservedBefore: 0, reservedAfter: 0,
    });
    await prisma.stockMovement.createMany({
      data: [
        movement(MovementType.adjustment_increase, 4),
        movement(MovementType.purchase_receipt, 6),
        movement(MovementType.order_shipment, 3),
      ],
    });

    const order = (items: number) =>
      prisma.pickingOrder.create({
        data: {
          tenantId, reference: `RP-${randomUUID().slice(0, 8)}`, client: 'Client', warehouseId, createdById: userId,
          items: {
            create: Array.from({ length: items }, () => ({
              productId: productIds[2], productCode: 'x', productName: 'x', quantity: 1,
            })),
          },
        },
      });
    await order(1);
    await order(3);
  });

  afterAll(async () => {
    await deleteTestTenant(prisma, tenantId);
    await prisma.$disconnect();
  });

  const list = (stockStatus: 'ok' | 'low' | 'out', limit = 20) =>
    products.findAll({ search: suffix, stockStatus, page: 1, limit }, warehouseId);

  it.each([
    ['ok', ['Ok']],
    ['low', ['Low']],
    ['out', ['Out', 'Unstocked']],
  ] as const)('filters %s products before paginating', async (status, names) => {
    const { data, meta } = await list(status);

    expect(meta.total).toBe(names.length);
    expect(data.map((p) => p.name.split(' ')[0])).toEqual(names);
  });

  it('keeps the total when a filtered page is smaller than the result set', async () => {
    const { data, meta } = await list('out', 1);

    expect(data).toHaveLength(1);
    expect(meta).toMatchObject({ total: 2, totalPages: 2 });
  });

  it('lists distinct categories of active products', async () => {
    const categories = await products.findCategories();

    expect(categories.filter((c) => c === 'reports')).toEqual(['reports']);
    expect([...categories].sort()).toEqual(categories);
  });

  it('includes product and warehouse names in the movement history', async () => {
    const { data } = await stock.findMovements({ warehouseId, page: 1, limit: 5 });

    expect(data[0].product.name).toContain(suffix);
    expect(data[0].warehouse.name).toBe('Reports');
  });

  it('summarizes stock with the same status rules as the product filter', async () => {
    const report = await reports.getStockStatus(warehouseId);

    expect(report.summary).toEqual({ total: 3, outOfStock: 1, lowStock: 1, ok: 1 });
    expect(report.lowStock[0]).toMatchObject({ available: 3, minStock: 5, warehouse: { id: warehouseId, name: 'Reports' } });
  });

  it('classifies adjustments as inbound and outbound movements', async () => {
    const dashboard = await reports.getDashboard(warehouseId);

    expect(dashboard.movements).toEqual({
      inboundToday: 2,
      outboundToday: 1,
      inboundUnitsToday: 10,
      outboundUnitsToday: 3,
    });
    expect(dashboard.stockAlerts).toMatchObject({ outOfStock: 1, lowStock: 1, totalReserved: 2 });
  });

  it('reports the average number of items per picking order', async () => {
    const stats = await reports.getPickingStats(warehouseId);

    expect(stats).toMatchObject({ total: 2, avgItemsPerOrder: 2 });
    expect(stats.byStatus.pending).toBe(2);
  });
});
