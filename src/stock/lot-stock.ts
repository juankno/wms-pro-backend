import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, WarehouseStock } from '@prisma/client';
import { requireTenantId } from '../tenancy/tenant-context';

// Like location-stock, every function expects the caller to hold the WarehouseStock row lock.

export interface LotAllocation {
  lotId: string;
  quantity: number;
}

export interface LotInput {
  code: string;
  expiresAt?: Date;
}

type Tx = Prisma.TransactionClient;
type StockRow = Pick<WarehouseStock, 'productId' | 'warehouseId'>;

export async function isLotTracked(tx: Tx, productId: string): Promise<boolean> {
  const product = await tx.product.findUnique({ where: { id: productId }, select: { lotTracking: true } });
  return product?.lotTracking ?? false;
}

// Finds or creates the lot; an existing lot keeps its expiry, which must match when both are given.
export async function resolveLot(tx: Tx, productId: string, input: LotInput) {
  const code = input.code.trim().toUpperCase();
  const existing = await tx.lot.findUnique({ where: { productId_code: { productId, code } } });
  if (!existing) {
    return tx.lot.create({ data: { tenantId: requireTenantId(), productId, code, expiresAt: input.expiresAt } });
  }
  if (input.expiresAt && existing.expiresAt && existing.expiresAt.getTime() !== input.expiresAt.getTime()) {
    throw new UnprocessableEntityException({
      error: 'LOT_EXPIRY_MISMATCH',
      message: `El lote ${code} ya existe con vencimiento ${existing.expiresAt.toISOString().slice(0, 10)}`,
    });
  }
  if (input.expiresAt && !existing.expiresAt) {
    return tx.lot.update({ where: { id: existing.id }, data: { expiresAt: input.expiresAt } });
  }
  return existing;
}

// Validates the lot input against the product and adds the units; returns the lot id (null if not tracked).
export async function receiveIntoLot(tx: Tx, stock: StockRow, quantity: number, input?: LotInput): Promise<string | null> {
  const tracked = await isLotTracked(tx, stock.productId);
  if (!tracked) {
    if (input) {
      throw new UnprocessableEntityException({ error: 'PRODUCT_NOT_LOT_TRACKED', message: 'El producto no maneja lotes' });
    }
    return null;
  }
  if (!input?.code) {
    throw new UnprocessableEntityException({ error: 'LOT_REQUIRED', message: 'El producto maneja lotes; indica el lote' });
  }
  const lot = await resolveLot(tx, stock.productId, input);
  await addToLots(tx, stock, [{ lotId: lot.id, quantity }]);
  return lot.id;
}

export async function addToLots(tx: Tx, stock: StockRow, allocations: LotAllocation[]): Promise<void> {
  for (const { lotId, quantity } of allocations) {
    await tx.lotStock.upsert({
      where: { lotId_warehouseId: { lotId, warehouseId: stock.warehouseId } },
      create: { tenantId: requireTenantId(), productId: stock.productId, warehouseId: stock.warehouseId, lotId, quantity },
      update: { quantity: { increment: quantity } },
    });
  }
}

// Takes the given lot, or first-expired-first-out (lots without expiry last). Untracked products return [].
export async function takeFromLots(tx: Tx, stock: StockRow, quantity: number, lotId?: string): Promise<LotAllocation[]> {
  if (!(await isLotTracked(tx, stock.productId))) {
    if (lotId) {
      throw new UnprocessableEntityException({ error: 'PRODUCT_NOT_LOT_TRACKED', message: 'El producto no maneja lotes' });
    }
    return [];
  }

  const rows = await tx.lotStock.findMany({
    where: { productId: stock.productId, warehouseId: stock.warehouseId, quantity: { gt: 0 }, ...(lotId && { lotId }) },
    include: { lot: { select: { code: true, expiresAt: true, createdAt: true } } },
  });
  rows.sort((a, b) => fefoOrder(a.lot, b.lot));

  const available = rows.reduce((sum, row) => sum + row.quantity, 0);
  if (available < quantity) {
    throw new ConflictException({
      error: 'INSUFFICIENT_LOT_STOCK',
      message: lotId ? 'El lote no tiene suficientes unidades' : 'Los lotes no tienen suficientes unidades',
      details: [{ productId: stock.productId, lotId, requested: quantity, available }],
    });
  }

  const allocations: LotAllocation[] = [];
  let remaining = quantity;
  for (const row of rows) {
    if (remaining === 0) break;
    const taken = Math.min(row.quantity, remaining);
    await tx.lotStock.update({ where: { id: row.id }, data: { quantity: row.quantity - taken } });
    allocations.push({ lotId: row.lotId, quantity: taken });
    remaining -= taken;
  }
  return allocations;
}

export function fefoOrder(
  a: { expiresAt: Date | null; createdAt: Date },
  b: { expiresAt: Date | null; createdAt: Date },
): number {
  if (a.expiresAt && b.expiresAt) return a.expiresAt.getTime() - b.expiresAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime();
  if (a.expiresAt) return -1;
  if (b.expiresAt) return 1;
  return a.createdAt.getTime() - b.createdAt.getTime();
}

export const singleLot = (allocations: LotAllocation[]) => (allocations.length === 1 ? allocations[0].lotId : undefined);

export async function recordPickedLots(tx: Tx, pickingItemId: string, allocations: LotAllocation[]): Promise<void> {
  for (const { lotId, quantity } of allocations) {
    await tx.pickingItemLot.upsert({
      where: { pickingItemId_lotId: { pickingItemId, lotId } },
      create: { pickingItemId, lotId, quantity },
      update: { quantity: { increment: quantity } },
    });
  }
}

// Puts picked units back into their lots, latest expiry first so the earliest-expiring ones keep shipping.
export async function returnPickedLots(
  tx: Tx,
  stock: StockRow,
  pickingItemIds: string[],
  quantity: number,
  lotId?: string,
): Promise<void> {
  if (!(await isLotTracked(tx, stock.productId))) {
    if (lotId) {
      throw new UnprocessableEntityException({ error: 'PRODUCT_NOT_LOT_TRACKED', message: 'El producto no maneja lotes' });
    }
    return;
  }
  const picks = await tx.pickingItemLot.findMany({
    where: { pickingItemId: { in: pickingItemIds }, quantity: { gt: 0 }, ...(lotId && { lotId }) },
    include: { lot: { select: { expiresAt: true, createdAt: true } } },
  });
  picks.sort((a, b) => fefoOrder(b.lot, a.lot));

  const returned: LotAllocation[] = [];
  let remaining = quantity;
  for (const pick of picks) {
    if (remaining === 0) break;
    const amount = Math.min(pick.quantity, remaining);
    await tx.pickingItemLot.update({ where: { id: pick.id }, data: { quantity: pick.quantity - amount } });
    returned.push({ lotId: pick.lotId, quantity: amount });
    remaining -= amount;
  }
  if (remaining > 0) {
    throw new ConflictException({
      error: 'INSUFFICIENT_LOT_STOCK',
      message: 'Las unidades a devolver no corresponden a los lotes recogidos',
      details: [{ productId: stock.productId, lotId, requested: quantity, available: quantity - remaining }],
    });
  }
  await addToLots(tx, stock, returned);
}
