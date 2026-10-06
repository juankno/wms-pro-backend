import { CycleCountStatus, LocationType, Role } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { effectivePermissions } from '../src/auth/permissions';
import { AuthUser } from '../src/common/types/request-with-user.interface';
import { CycleCountsService } from '../src/cycle-counts/cycle-counts.service';
import { StockService } from '../src/stock/stock.service';
import { createTestTenant, deleteTestTenant, scopedTo, testPrisma } from './support/tenancy';

describe('Cycle counts (integration)', () => {
  const prisma = testPrisma();
  let tenantId: string;
  const counts = scopedTo(new CycleCountsService(prisma), () => tenantId);
  const stock = scopedTo(new StockService(prisma), () => tenantId);

  let supervisor: AuthUser;
  let counter: AuthUser;
  let warehouseId: string;
  let binId: string;
  let plainId: string;
  let lotProductId: string;

  const summary = (productId: string) => stock.productLocations(productId, warehouseId);
  const lineOf = (count: Awaited<ReturnType<typeof counts.findById>>, productId: string, locationId: string | null) =>
    count.lines.find((line) => line.productId === productId && line.locationId === locationId)!;

  beforeAll(async () => {
    tenantId = (await createTestTenant(prisma)).id;
    warehouseId = (await prisma.warehouse.create({ data: { tenantId, code: 'W', name: 'W' } })).id;
    const user = await prisma.user.create({
      data: { tenantId, username: 'sup', email: 's@cc.test', name: 'Supervisor', password: 'x', role: Role.supervisor, warehouseId },
    });
    supervisor = {
      id: user.id, sub: user.id, tenantId, username: 'sup', name: 'Supervisor',
      role: Role.supervisor, warehouseId, permissions: effectivePermissions(Role.supervisor),
    };
    counter = { ...supervisor, role: Role.operator, permissions: effectivePermissions(Role.operator) };
    binId = (await prisma.location.create({ data: { tenantId, warehouseId, code: 'A-1', type: LocationType.bin } })).id;
    plainId = (await prisma.product.create({ data: { tenantId, code: 'TOR', name: 'Tornillo', category: 'c' } })).id;
    lotProductId = (await prisma.product.create({ data: { tenantId, code: 'LEC', name: 'Leche', category: 'c', lotTracking: true } })).id;
  });

  beforeEach(async () => {
    await prisma.locationStock.deleteMany({ where: { tenantId } });
    await prisma.lotStock.deleteMany({ where: { tenantId } });
    await prisma.warehouseStock.deleteMany({ where: { tenantId } });
    await prisma.warehouseStock.createMany({
      data: [
        { tenantId, productId: plainId, warehouseId, onHand: 10 },
        { tenantId, productId: lotProductId, warehouseId, onHand: 0 },
      ],
    });
    await prisma.locationStock.create({ data: { tenantId, warehouseId, productId: plainId, locationId: binId, quantity: 8 } });
  });

  afterAll(async () => {
    await deleteTestTenant(prisma, tenantId);
    await prisma.$disconnect();
  });

  it('snapshots expected quantities and applies the differences on approval', async () => {
    const count = await counts.create({ warehouseId, productIds: [plainId] }, supervisor);
    expect(count.reference).toMatch(/^CC-\d{5}$/);
    expect(count.lines.map((line) => [line.location?.code ?? null, line.expectedQuantity])).toEqual([
      ['A-1', 8],
      [null, 2],
    ]);

    await counts.recordCount(count.id, lineOf(count, plainId, binId).id, { countedQuantity: 6 }, counter);
    await counts.recordCount(count.id, lineOf(count, plainId, null).id, { countedQuantity: 5 }, counter);
    const submitted = await counts.submit(count.id, counter);
    expect(submitted.lines.map((line) => line.difference)).toEqual([-2, 3]);

    const approved = await counts.approve(count.id, supervisor);
    expect(approved.status).toBe(CycleCountStatus.approved);
    expect(await summary(plainId)).toMatchObject({ onHand: 11, unlocated: 5, locations: [{ quantity: 6 }] });
    const movements = await prisma.stockMovement.findMany({ where: { productId: plainId, referenceType: 'cycle_count' } });
    expect(movements.map((m) => [m.type, m.quantity]).sort()).toEqual([['adjustment_decrease', 2], ['adjustment_increase', 3]]);
  });

  it('hides expected quantities from counters in blind counts and requires every line', async () => {
    const count = await counts.create({ warehouseId, locationIds: [binId], blind: true }, supervisor);
    const forCounter = await counts.findById(count.id, counter);
    expect(forCounter.lines[0]).toMatchObject({ expectedQuantity: null, difference: null });
    expect((await counts.findById(count.id, supervisor)).lines[0].expectedQuantity).toBe(8);

    await expect(counts.submit(count.id, counter)).rejects.toMatchObject({ response: { error: 'COUNT_INCOMPLETE' } });
  });

  it('adds found products and asks for the lot of extra units of lot-tracked products', async () => {
    const count = await counts.create({ warehouseId, locationIds: [binId] }, supervisor);
    await counts.recordCount(count.id, count.lines[0].id, { countedQuantity: 8 }, counter);
    const withFound = await counts.addLine(count.id, { productId: lotProductId, locationId: binId, countedQuantity: 4 }, counter);
    await counts.submit(count.id, counter);
    await expect(counts.approve(count.id, supervisor)).rejects.toMatchObject({ response: { error: 'LOT_REQUIRED' } });

    await counts.reopen(count.id, supervisor);
    await counts.recordCount(count.id, lineOf(withFound, lotProductId, binId).id, { countedQuantity: 4, lotCode: 'l-9' }, counter);
    await counts.submit(count.id, counter);
    await counts.approve(count.id, supervisor);
    expect(await summary(lotProductId)).toMatchObject({ onHand: 4, lots: [{ lot: { code: 'L-9' }, quantity: 4 }] });
  });

  it('cancels without touching stock', async () => {
    const count = await counts.create({ warehouseId, productIds: [plainId] }, supervisor);
    expect((await counts.cancel(count.id, supervisor)).status).toBe(CycleCountStatus.cancelled);
    expect((await summary(plainId)).onHand).toBe(10);
    await expect(counts.recordCount(count.id, count.lines[0].id, { countedQuantity: 1 }, counter)).rejects.toMatchObject({
      response: { error: 'COUNT_INVALID_STATUS' },
    });
  });
});
