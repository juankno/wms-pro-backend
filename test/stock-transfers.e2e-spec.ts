import { LocationType, Role, StockTransferStatus } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { effectivePermissions } from '../src/auth/permissions';
import { AuthUser } from '../src/common/types/request-with-user.interface';
import { StockService } from '../src/stock/stock.service';
import { receivedLots, StockTransfersService } from '../src/transfers/stock-transfers.service';
import { createTestTenant, deleteTestTenant, scopedTo, testPrisma } from './support/tenancy';

describe('Stock transfers in transit (integration)', () => {
  const prisma = testPrisma();
  let tenantId: string;
  const transfers = scopedTo(new StockTransfersService(prisma), () => tenantId);
  const stock = scopedTo(new StockService(prisma), () => tenantId);

  let admin: AuthUser;
  let originUser: AuthUser;
  let fromId: string;
  let toId: string;
  let destinationBin: string;
  let productId: string;
  let lotProductId: string;

  const summary = (product: string, warehouse: string) => stock.productLocations(product, warehouse);

  beforeAll(async () => {
    tenantId = (await createTestTenant(prisma)).id;
    [fromId, toId] = (
      await Promise.all(['BOG', 'MED'].map((code) => prisma.warehouse.create({ data: { tenantId, code, name: code } })))
    ).map((warehouse) => warehouse.id);
    const user = await prisma.user.create({
      data: { tenantId, username: 'admin', email: 'a@tr.test', name: 'Admin', password: 'x', role: Role.admin },
    });
    admin = {
      id: user.id, sub: user.id, tenantId, username: 'admin', name: 'Admin',
      role: Role.admin, warehouseId: null, permissions: effectivePermissions(Role.admin),
    };
    originUser = { ...admin, role: Role.supervisor, warehouseId: fromId, permissions: effectivePermissions(Role.supervisor) };
    destinationBin = (await prisma.location.create({ data: { tenantId, warehouseId: toId, code: 'R-1', type: LocationType.bin } })).id;
    productId = (await prisma.product.create({ data: { tenantId, code: 'TOR', name: 'Tornillo', category: 'c' } })).id;
    lotProductId = (await prisma.product.create({ data: { tenantId, code: 'LEC', name: 'Leche', category: 'c', lotTracking: true } })).id;
  });

  beforeEach(async () => {
    await prisma.locationStock.deleteMany({ where: { tenantId } });
    await prisma.lotStock.deleteMany({ where: { tenantId } });
    await prisma.lot.deleteMany({ where: { tenantId } });
    await prisma.warehouseStock.deleteMany({ where: { tenantId } });
    await prisma.warehouseStock.createMany({
      data: [
        { tenantId, productId, warehouseId: fromId, onHand: 10 },
        { tenantId, productId: lotProductId, warehouseId: fromId, onHand: 6 },
      ],
    });
    const [early, late] = await Promise.all([
      prisma.lot.create({ data: { tenantId, productId: lotProductId, code: 'E', expiresAt: new Date('2027-01-01') } }),
      prisma.lot.create({ data: { tenantId, productId: lotProductId, code: 'L', expiresAt: new Date('2028-01-01') } }),
    ]);
    await prisma.lotStock.createMany({
      data: [
        { tenantId, productId: lotProductId, warehouseId: fromId, lotId: early.id, quantity: 3 },
        { tenantId, productId: lotProductId, warehouseId: fromId, lotId: late.id, quantity: 3 },
      ],
    });
  });

  afterAll(async () => {
    await deleteTestTenant(prisma, tenantId);
    await prisma.$disconnect();
  });

  it('splits received units over the lots in the order they left', () => {
    expect(receivedLots([{ lotId: 'a', quantity: 3 }, { lotId: 'b', quantity: 2 }], 4)).toEqual([
      { lotId: 'a', quantity: 3 },
      { lotId: 'b', quantity: 1 },
    ]);
  });

  it('keeps units in transit until the destination receives them', async () => {
    const transfer = await transfers.send(
      { fromWarehouseId: fromId, toWarehouseId: toId, items: [{ productId, quantity: 4 }, { productId: lotProductId, quantity: 4 }] },
      originUser,
    );
    expect(transfer).toMatchObject({ status: StockTransferStatus.in_transit, reference: expect.stringMatching(/^TR-\d{5}$/) });
    expect((await summary(productId, fromId)).onHand).toBe(6);
    await expect(summary(productId, toId)).rejects.toMatchObject({ response: { error: 'STOCK_NOT_FOUND' } });

    const lotItem = transfer.items.find((item) => item.productId === lotProductId)!;
    const received = await transfers.receive(
      transfer.id,
      { items: [{ itemId: transfer.items.find((i) => i.productId === productId)!.id, receivedQuantity: 3, locationId: destinationBin }] },
      admin,
    );

    expect(received.status).toBe(StockTransferStatus.received);
    expect(received.items.map((item) => [item.product.code, item.quantity, item.receivedQuantity]).sort()).toEqual([
      ['LEC', 4, 4],
      ['TOR', 4, 3],
    ]);
    expect(await summary(productId, toId)).toMatchObject({ onHand: 3, locations: [{ location: { code: 'R-1' }, quantity: 3 }] });
    expect((await summary(lotProductId, toId)).lots.map((l) => [l.lot.code, l.quantity])).toEqual([['E', 3], ['L', 1]]);
    expect(lotItem.lotAllocations).toHaveLength(2);
  });

  it('checks origin access, stock and double reception', async () => {
    const destinationUser: AuthUser = { ...originUser, warehouseId: toId };
    await expect(
      transfers.send({ fromWarehouseId: fromId, toWarehouseId: toId, items: [{ productId, quantity: 1 }] }, destinationUser),
    ).rejects.toMatchObject({ response: { error: 'WAREHOUSE_FORBIDDEN' } });
    await expect(
      transfers.send({ fromWarehouseId: fromId, toWarehouseId: toId, items: [{ productId, quantity: 50 }] }, admin),
    ).rejects.toMatchObject({ response: { error: 'INSUFFICIENT_STOCK' } });
    expect((await summary(productId, fromId)).onHand).toBe(10);

    const transfer = await transfers.send({ fromWarehouseId: fromId, toWarehouseId: toId, items: [{ productId, quantity: 1 }] }, admin);
    await expect(transfers.receive(transfer.id, {}, originUser)).rejects.toMatchObject({ response: { error: 'WAREHOUSE_FORBIDDEN' } });
    await transfers.receive(transfer.id, {}, destinationUser);
    await expect(transfers.receive(transfer.id, {}, destinationUser)).rejects.toMatchObject({
      response: { error: 'TRANSFER_ALREADY_RECEIVED' },
    });
  });
});
