import { Prisma, WarehouseStock } from '@prisma/client';
import { requireTenantId } from '../tenancy/tenant-context';

export async function lockWarehouseStock(
  tx: Prisma.TransactionClient,
  productId: string,
  warehouseId: string,
): Promise<WarehouseStock | null> {
  const rows = await tx.$queryRaw<WarehouseStock[]>`
    SELECT * FROM warehouse_stock
    WHERE "tenantId" = ${requireTenantId()} AND "productId" = ${productId} AND "warehouseId" = ${warehouseId}
    FOR UPDATE`;
  return rows[0] ?? null;
}

// Locks in productId order so concurrent orders touching the same products cannot deadlock.
export async function lockWarehouseStocks(
  tx: Prisma.TransactionClient,
  warehouseId: string,
  productIds: string[],
): Promise<Map<string, WarehouseStock>> {
  const locked = new Map<string, WarehouseStock>();
  for (const productId of [...new Set(productIds)].sort()) {
    const stock = await lockWarehouseStock(tx, productId, warehouseId);
    if (stock) locked.set(productId, stock);
  }
  return locked;
}

export function sumByProduct<T extends { productId: string }>(items: T[], quantity: (item: T) => number) {
  const totals = new Map<string, number>();
  for (const item of items) {
    totals.set(item.productId, (totals.get(item.productId) ?? 0) + quantity(item));
  }
  return totals;
}
