import { BadRequestException, ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { Location, LocationType, OrderStatus, Role } from '@prisma/client';
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActivityService } from '../src/activity/activity.service';
import { effectivePermissions } from '../src/auth/permissions';
import { AuthUser } from '../src/common/types/request-with-user.interface';
import { LocationsService } from '../src/locations/locations.service';
import { PackingService } from '../src/packing/packing.service';
import { PickingService } from '../src/picking/picking.service';
import { StockService } from '../src/stock/stock.service';
import { PlanLimitsService } from '../src/tenancy/plan-limits.service';
import { UploadsService } from '../src/uploads/uploads.service';
import { createTestTenant, deleteTestTenant, scopedTo, testPrisma } from './support/tenancy';

describe('Stock by location (integration)', () => {
  const prisma = testPrisma();
  let tenantId: string;
  const scoped = <T extends object>(service: T) => scopedTo(service, () => tenantId);
  const activity = new ActivityService(prisma);
  const uploads = { deleteFile: () => undefined } as unknown as UploadsService;
  const stock = scoped(new StockService(prisma));
  const locations = scoped(new LocationsService(prisma));
  const picking = scoped(new PickingService(prisma, activity, uploads, new PlanLimitsService(prisma)));
  const packing = scoped(new PackingService(prisma, activity, uploads));

  let admin: AuthUser;
  let warehouseId: string;
  let productId: string;
  let binA: Location;
  let binB: Location;
  let smallBin: Location;
  let aisle: Location;

  const operator = () => ({ operatorId: admin.id, operatorName: admin.name });
  const summary = () => stock.productLocations(productId, warehouseId);
  const quantities = async () => {
    const s = await summary();
    return Object.fromEntries([
      ...s.locations.map((l) => [l.location.code, l.quantity]),
      ['picked', s.picked],
      ['unlocated', s.unlocated],
    ]) as Record<string, number>;
  };

  beforeAll(async () => {
    tenantId = (await createTestTenant(prisma)).id;
    const warehouse = await prisma.warehouse.create({ data: { tenantId, code: 'W1', name: 'Main' } });
    warehouseId = warehouse.id;
    const user = await prisma.user.create({
      data: { tenantId, username: 'admin', email: 'admin@ls.test', name: 'Admin', role: Role.admin, password: 'x', warehouseId },
    });
    admin = {
      id: user.id, sub: user.id, tenantId, username: 'admin', name: 'Admin',
      role: Role.admin, warehouseId, permissions: effectivePermissions(Role.admin),
    };
    aisle = await locations.create({ warehouseId, code: 'A', type: LocationType.aisle }, admin);
    binA = await locations.create({ warehouseId, parentId: aisle.id, code: 'A-1', type: LocationType.bin, pickSequence: 1 }, admin);
    binB = await locations.create({ warehouseId, parentId: aisle.id, code: 'A-2', type: LocationType.bin, pickSequence: 2 }, admin);
    smallBin = await locations.create({ warehouseId, code: 'S-1', type: LocationType.bin, capacity: 3 }, admin);
  });

  beforeEach(async () => {
    const product = await prisma.product.create({
      data: { tenantId, code: `P-${randomUUID().slice(0, 8)}`, name: 'Product', category: 'test' },
    });
    productId = product.id;
    await prisma.warehouseStock.create({ data: { tenantId, productId, warehouseId } });
  });

  afterAll(async () => {
    await deleteTestTenant(prisma, tenantId);
    await prisma.$disconnect();
  });

  const receive = (quantity: number, locationId?: string) =>
    stock.registerMovement({ productId, warehouseId, type: 'purchase_receipt', quantity, locationId, ...operator() });

  it('receives into a location or leaves the units without one', async () => {
    await receive(6, binA.id);
    await receive(4);

    expect(await quantities()).toEqual({ 'A-1': 6, picked: 0, unlocated: 4 });
    const movement = await prisma.stockMovement.findFirstOrThrow({ where: { productId, locationId: binA.id } });
    expect(movement).toMatchObject({ type: 'purchase_receipt', quantity: 6 });
  });

  it('relocates between locations and validates the destination', async () => {
    await receive(5);
    await stock.relocate({ productId, warehouseId, toLocationId: binB.id, quantity: 5, ...operator() });
    await stock.relocate({ productId, warehouseId, fromLocationId: binB.id, toLocationId: smallBin.id, quantity: 3, ...operator() });
    expect(await quantities()).toEqual({ 'A-2': 2, 'S-1': 3, picked: 0, unlocated: 0 });

    const move = (toLocationId: string, quantity = 1) =>
      stock.relocate({ productId, warehouseId, fromLocationId: binB.id, toLocationId, quantity, ...operator() });
    await expect(move(smallBin.id)).rejects.toMatchObject({ response: { error: 'LOCATION_CAPACITY_EXCEEDED' } });
    await expect(move(aisle.id)).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(move(binB.id)).rejects.toBeInstanceOf(BadRequestException);
    await expect(move(binA.id, 5)).rejects.toMatchObject({ response: { error: 'INSUFFICIENT_LOCATION_STOCK' } });
  });

  it('takes decreases from the given location or in pick sequence', async () => {
    await receive(2, binB.id);
    await receive(3, binA.id);

    await stock.registerMovement({ productId, warehouseId, type: 'adjustment_decrease', quantity: 4, ...operator() });
    expect(await quantities()).toEqual({ 'A-2': 1, picked: 0, unlocated: 0 });

    await expect(
      stock.registerMovement({ productId, warehouseId, type: 'adjustment_decrease', quantity: 1, locationId: binA.id, ...operator() }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('moves picked units out of their locations until the packing ships them', async () => {
    await receive(3, binA.id);
    await receive(3, binB.id);
    const order = await picking.create({ reference: `R-${randomUUID().slice(0, 6)}`, client: 'C', warehouseId, items: [{ productId, quantity: 5 }] }, admin);
    expect(order.items[0].location).toBe('A-1, A-2');

    const itemId = order.items[0].id;
    await picking.updateItem(order.id, itemId, 4, admin);
    expect(await quantities()).toEqual({ 'A-2': 2, picked: 4, unlocated: 0 });

    await picking.updateItem(order.id, itemId, 3, admin, binA.id);
    expect(await quantities()).toEqual({ 'A-1': 1, 'A-2': 2, picked: 3, unlocated: 0 });

    await picking.updateStatus(order.id, OrderStatus.in_progress, admin);
    await picking.updateStatus(order.id, OrderStatus.completed, admin);
    const pack = await packing.create({ pickingOrderId: order.id, reference: order.reference }, admin);
    await packing.updateItem(pack.id, pack.items[0].id, 2, admin);
    await packing.updateStatus(pack.id, OrderStatus.in_progress, admin);
    await packing.updateStatus(pack.id, OrderStatus.completed, admin);

    expect(await quantities()).toEqual({ 'A-1': 1, 'A-2': 2, picked: 0, unlocated: 1 });
    expect(await summary()).toMatchObject({ onHand: 4, reserved: 0 });
  });

  it('returns picked units to the warehouse when the picking is cancelled', async () => {
    await receive(4, binA.id);
    const order = await picking.create({ reference: `R-${randomUUID().slice(0, 6)}`, client: 'C', warehouseId, items: [{ productId, quantity: 4 }] }, admin);
    await picking.updateItem(order.id, order.items[0].id, 4, admin);

    await picking.updateStatus(order.id, OrderStatus.cancelled, admin);

    expect(await quantities()).toEqual({ picked: 0, unlocated: 4 });
    expect(await summary()).toMatchObject({ onHand: 4, reserved: 0 });
  });

  it('refuses to delete a location that holds stock', async () => {
    await receive(1, binB.id);
    await expect(locations.delete(binB.id, admin)).rejects.toMatchObject({ response: { error: 'LOCATION_HAS_STOCK' } });
  });
});
