import type { PrismaClient } from '@prisma/client';

export interface StockProblem {
  tenant: string;
  warehouse: string;
  product: string;
  issue: string;
}

export interface StockIntegrityReport {
  checked: number;
  problems: StockProblem[];
}

type StockReader = Pick<PrismaClient, 'warehouseStock' | 'locationStock' | 'lotStock'>;

// Read-only check of the stock invariants: on hand = locations + picked + unlocated, lots = on shelves.
// With a tenant-scoped client it covers that tenant; with a plain client, every tenant.
export async function checkStockIntegrity(db: StockReader): Promise<StockIntegrityReport> {
  const [stocks, located, lots] = await Promise.all([
    db.warehouseStock.findMany({
      include: {
        tenant: { select: { slug: true } },
        warehouse: { select: { code: true } },
        product: { select: { code: true, lotTracking: true } },
      },
    }),
    db.locationStock.groupBy({ by: ['productId', 'warehouseId'], _sum: { quantity: true } }),
    db.lotStock.groupBy({ by: ['productId', 'warehouseId'], _sum: { quantity: true } }),
  ]);
  const sumOf = (rows: typeof located, productId: string, warehouseId: string) =>
    rows.find((row) => row.productId === productId && row.warehouseId === warehouseId)?._sum.quantity ?? 0;

  const problems: StockProblem[] = [];
  for (const stock of stocks) {
    const report = (issue: string) =>
      problems.push({ tenant: stock.tenant.slug, warehouse: stock.warehouse.code, product: stock.product.code, issue });
    const inLocations = sumOf(located, stock.productId, stock.warehouseId);
    const inLots = sumOf(lots, stock.productId, stock.warehouseId);
    const onShelves = stock.onHand - stock.picked;

    if (stock.onHand < 0 || stock.reserved < 0 || stock.picked < 0) report('saldo negativo');
    if (stock.reserved > stock.onHand) report(`reservado ${stock.reserved} > físico ${stock.onHand}`);
    if (stock.picked > stock.onHand) report(`recogido ${stock.picked} > físico ${stock.onHand}`);
    if (inLocations > onShelves) report(`ubicaciones ${inLocations} > en estantería ${onShelves}`);
    if (stock.product.lotTracking && inLots !== onShelves) report(`lotes ${inLots} ≠ en estantería ${onShelves}`);
  }
  return { checked: stocks.length, problems };
}
