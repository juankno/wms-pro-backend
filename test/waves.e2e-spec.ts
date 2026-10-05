import { LocationType, OrderStatus, Priority, Role, WaveStatus } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActivityService } from '../src/activity/activity.service';
import { effectivePermissions } from '../src/auth/permissions';
import { AuthUser } from '../src/common/types/request-with-user.interface';
import { PickingService } from '../src/picking/picking.service';
import { PlanLimitsService } from '../src/tenancy/plan-limits.service';
import { UploadsService } from '../src/uploads/uploads.service';
import { WavesService } from '../src/waves/waves.service';
import { createTestTenant, deleteTestTenant, scopedTo, testPrisma } from './support/tenancy';

describe('Picking waves (integration)', () => {
  const prisma = testPrisma();
  let tenantId: string;
  const uploads = { deleteFile: () => undefined } as unknown as UploadsService;
  const pickingService = new PickingService(prisma, new ActivityService(prisma), uploads, new PlanLimitsService(prisma));
  const picking = scopedTo(pickingService, () => tenantId);
  const waves = scopedTo(new WavesService(prisma, pickingService), () => tenantId);

  let admin: AuthUser;
  let warehouseId: string;
  let otherWarehouseId: string;
  let near: string;
  let far: string;

  const order = (items: { productId: string; quantity: number }[], priority: Priority = Priority.medium, warehouse = warehouseId) =>
    picking.create({ client: 'C', warehouseId: warehouse, priority, items }, admin);

  beforeAll(async () => {
    tenantId = (await createTestTenant(prisma)).id;
    [warehouseId, otherWarehouseId] = (
      await Promise.all(['W1', 'W2'].map((code) => prisma.warehouse.create({ data: { tenantId, code, name: code } })))
    ).map((warehouse) => warehouse.id);
    const user = await prisma.user.create({
      data: { tenantId, username: 'admin', email: 'a@wave.test', name: 'Admin', password: 'x', role: Role.admin },
    });
    admin = {
      id: user.id, sub: user.id, tenantId, username: 'admin', name: 'Admin',
      role: Role.admin, warehouseId: null, permissions: effectivePermissions(Role.admin),
    };
    [near, far] = (
      await Promise.all(['NEAR', 'FAR'].map((code) => prisma.product.create({ data: { tenantId, code, name: code, category: 'c' } })))
    ).map((product) => product.id);
    const [front, back] = await Promise.all([
      prisma.location.create({ data: { tenantId, warehouseId, code: 'A-1', type: LocationType.bin, pickSequence: 1 } }),
      prisma.location.create({ data: { tenantId, warehouseId, code: 'Z-9', type: LocationType.bin, pickSequence: 90 } }),
    ]);
    await prisma.locationStock.createMany({
      data: [
        { tenantId, warehouseId, productId: near, locationId: front.id, quantity: 50 },
        { tenantId, warehouseId, productId: far, locationId: back.id, quantity: 50 },
      ],
    });
  });

  beforeEach(async () => {
    await prisma.warehouseStock.deleteMany({ where: { tenantId } });
    await prisma.warehouseStock.createMany({
      data: [near, far].flatMap((productId) => [
        { tenantId, productId, warehouseId, onHand: 50 },
        { tenantId, productId, warehouseId: otherWarehouseId, onHand: 50 },
      ]),
    });
  });

  afterAll(async () => {
    await deleteTestTenant(prisma, tenantId);
    await prisma.$disconnect();
  });

  it('builds a consolidated pick list in walking order', async () => {
    const a = await order([{ productId: far, quantity: 2 }, { productId: near, quantity: 3 }]);
    const b = await order([{ productId: near, quantity: 4 }]);
    const wave = await waves.create({ pickingOrderIds: [a.id, b.id] }, admin);
    expect(wave.reference).toMatch(/^OL-\d{5}$/);

    const list = await waves.pickList(wave.id, admin);
    expect(list.map((row) => [row.productCode, row.quantity, row.locations[0].code])).toEqual([
      ['NEAR', 7, 'A-1'],
      ['FAR', 2, 'Z-9'],
    ]);
    expect(list[0].orders.map((o) => o.reference)).toEqual([a.reference, b.reference]);
  });

  it('splits a pick by priority and age, all or nothing', async () => {
    const low = await order([{ productId: near, quantity: 3 }], Priority.low);
    const high = await order([{ productId: near, quantity: 2 }], Priority.high);
    const wave = await waves.create({ pickingOrderIds: [low.id, high.id] }, admin);

    const row = await waves.pick(wave.id, { productId: near, quantity: 4 }, admin);
    expect(row).toMatchObject({ picked: 4, remaining: 1 });
    const picked = async (id: string) => (await prisma.pickingItem.findFirstOrThrow({ where: { pickingOrderId: id } })).pickedQuantity;
    expect([await picked(high.id), await picked(low.id)]).toEqual([2, 2]);

    await expect(waves.pick(wave.id, { productId: near, quantity: 2 }, admin)).rejects.toMatchObject({ response: { error: 'QUANTITY_EXCEEDED' } });
    expect(await picked(low.id)).toBe(2);
  });

  it('completes picked orders and releases untouched ones', async () => {
    const done = await order([{ productId: near, quantity: 1 }]);
    const untouched = await order([{ productId: far, quantity: 1 }]);
    const wave = await waves.create({ pickingOrderIds: [done.id, untouched.id] }, admin);
    await waves.pick(wave.id, { productId: near, quantity: 1 }, admin);

    const completed = await waves.complete(wave.id, admin);
    expect(completed.status).toBe(WaveStatus.completed);
    const [first, second] = await Promise.all([done.id, untouched.id].map((id) => prisma.pickingOrder.findUniqueOrThrow({ where: { id } })));
    expect(first).toMatchObject({ status: OrderStatus.completed, waveId: wave.id });
    expect(second).toMatchObject({ status: OrderStatus.pending, waveId: null });
  });

  it('rejects mixed warehouses and orders already in a wave', async () => {
    const a = await order([{ productId: near, quantity: 1 }]);
    const b = await order([{ productId: near, quantity: 1 }], Priority.medium, otherWarehouseId);
    await expect(waves.create({ pickingOrderIds: [a.id, b.id] }, admin)).rejects.toMatchObject({ response: { error: 'MIXED_WAREHOUSES' } });

    const c = await order([{ productId: near, quantity: 1 }]);
    const wave = await waves.create({ pickingOrderIds: [a.id, c.id] }, admin);
    const d = await order([{ productId: near, quantity: 1 }]);
    await expect(waves.create({ pickingOrderIds: [c.id, d.id] }, admin)).rejects.toMatchObject({ response: { error: 'ORDER_NOT_WAVEABLE' } });

    await waves.cancel(wave.id, admin);
    expect((await prisma.pickingOrder.findUniqueOrThrow({ where: { id: c.id } })).waveId).toBeNull();
  });
});
