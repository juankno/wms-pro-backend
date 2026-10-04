import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, WarehouseStock } from '@prisma/client';
import { requireTenantId } from '../tenancy/tenant-context';

// Every function expects the WarehouseStock row of the product to be locked by the caller,
// which serializes all location changes of that product in that warehouse.

export interface Allocation {
  locationId: string | null;
  quantity: number;
}

type Tx = Prisma.TransactionClient;
type StockRow = Pick<WarehouseStock, 'productId' | 'warehouseId' | 'onHand' | 'picked'>;

async function locatedQuantity(tx: Tx, stock: StockRow): Promise<number> {
  const { _sum } = await tx.locationStock.aggregate({
    where: { productId: stock.productId, warehouseId: stock.warehouseId },
    _sum: { quantity: true },
  });
  return _sum.quantity ?? 0;
}

// Units on hand that are neither stored in a location nor picked.
export async function unlocatedQuantity(tx: Tx, stock: StockRow): Promise<number> {
  return stock.onHand - stock.picked - (await locatedQuantity(tx, stock));
}

export async function assertUnlocatedAvailable(tx: Tx, stock: StockRow, quantity: number): Promise<void> {
  const available = await unlocatedQuantity(tx, stock);
  if (available < quantity) {
    throw new ConflictException({
      error: 'STOCK_IN_LOCATIONS',
      message: 'El stock está guardado en ubicaciones; indica de cuál sale',
      details: [{ productId: stock.productId, requested: quantity, available }],
    });
  }
}

async function storableLocation(tx: Tx, locationId: string, warehouseId: string) {
  const location = await tx.location.findUnique({ where: { id: locationId } });
  if (!location || location.warehouseId !== warehouseId || !location.active) {
    throw new NotFoundException({ error: 'LOCATION_NOT_FOUND', message: 'Ubicación no encontrada en el almacén' });
  }
  if (!location.storable) {
    throw new UnprocessableEntityException({
      error: 'LOCATION_NOT_STORABLE',
      message: `La ubicación ${location.code} no admite stock`,
    });
  }
  return location;
}

// Capacity is checked across products without locking them, so concurrent put-aways may exceed it slightly.
export async function putAway(tx: Tx, stock: StockRow, locationId: string, quantity: number): Promise<void> {
  const location = await storableLocation(tx, locationId, stock.warehouseId);
  if (location.capacity !== null) {
    const { _sum } = await tx.locationStock.aggregate({ where: { locationId }, _sum: { quantity: true } });
    const used = _sum.quantity ?? 0;
    if (used + quantity > location.capacity) {
      throw new ConflictException({
        error: 'LOCATION_CAPACITY_EXCEEDED',
        message: `La ubicación ${location.code} admite ${location.capacity} unidades y tiene ${used}`,
        details: [{ locationId, capacity: location.capacity, used, requested: quantity }],
      });
    }
  }
  await tx.locationStock.upsert({
    where: { productId_locationId: { productId: stock.productId, locationId } },
    create: {
      tenantId: requireTenantId(),
      productId: stock.productId,
      warehouseId: stock.warehouseId,
      locationId,
      quantity,
    },
    update: { quantity: { increment: quantity } },
  });
}

export async function takeFromLocation(tx: Tx, stock: StockRow, locationId: string, quantity: number): Promise<void> {
  const row = await tx.locationStock.findUnique({
    where: { productId_locationId: { productId: stock.productId, locationId } },
  });
  if (!row || row.warehouseId !== stock.warehouseId || row.quantity < quantity) {
    throw new ConflictException({
      error: 'INSUFFICIENT_LOCATION_STOCK',
      message: 'La ubicación no tiene suficientes unidades',
      details: [{ productId: stock.productId, locationId, requested: quantity, available: row?.quantity ?? 0 }],
    });
  }
  await decrement(tx, row.id, row.quantity, quantity);
}

// Takes from the given location, or else from locations in pick sequence and then from unlocated stock.
export async function allocateOutbound(
  tx: Tx,
  stock: StockRow,
  quantity: number,
  locationId?: string,
): Promise<Allocation[]> {
  if (locationId) {
    await takeFromLocation(tx, stock, locationId, quantity);
    return [{ locationId, quantity }];
  }

  const unlocated = await unlocatedQuantity(tx, stock);
  const rows = await tx.locationStock.findMany({
    where: { productId: stock.productId, warehouseId: stock.warehouseId, quantity: { gt: 0 } },
    include: { location: { select: { pickSequence: true, code: true } } },
  });
  rows.sort((a, b) => a.location.pickSequence - b.location.pickSequence || a.location.code.localeCompare(b.location.code));

  const located = rows.reduce((sum, row) => sum + row.quantity, 0);
  if (located + unlocated < quantity) {
    throw new ConflictException({
      error: 'INSUFFICIENT_STOCK',
      message: 'No hay unidades suficientes para recoger',
      details: [{ productId: stock.productId, requested: quantity, available: located + unlocated }],
    });
  }

  const allocations: Allocation[] = [];
  let remaining = quantity;
  for (const row of rows) {
    if (remaining === 0) break;
    const taken = Math.min(row.quantity, remaining);
    await decrement(tx, row.id, row.quantity, taken);
    allocations.push({ locationId: row.locationId, quantity: taken });
    remaining -= taken;
  }
  if (remaining > 0) allocations.push({ locationId: null, quantity: remaining });
  return allocations;
}

const MAX_SUGGESTED_LOCATIONS = 3;

// Codes of the locations holding each product, in pick sequence, to guide the picker.
export async function suggestedLocations(tx: Tx, warehouseId: string, productIds: string[]): Promise<Map<string, string>> {
  const rows = await tx.locationStock.findMany({
    where: { warehouseId, productId: { in: productIds }, quantity: { gt: 0 } },
    include: { location: { select: { code: true, pickSequence: true } } },
  });
  rows.sort((a, b) => a.location.pickSequence - b.location.pickSequence || a.location.code.localeCompare(b.location.code));

  const codes = new Map<string, string[]>();
  for (const row of rows) {
    const list = codes.get(row.productId) ?? [];
    if (list.length < MAX_SUGGESTED_LOCATIONS) codes.set(row.productId, [...list, row.location.code]);
  }
  return new Map([...codes].map(([productId, list]) => [productId, list.join(', ')]));
}

async function decrement(tx: Tx, rowId: string, current: number, quantity: number) {
  if (current === quantity) await tx.locationStock.delete({ where: { id: rowId } });
  else await tx.locationStock.update({ where: { id: rowId }, data: { quantity: current - quantity } });
}
