import { PrismaClient } from '@prisma/client';

// Read-only check of the stock invariants across every tenant; exits with 1 if any is broken.
const prisma = new PrismaClient();

interface Problem {
  tenant: string;
  warehouse: string;
  product: string;
  issue: string;
}

async function main() {
  const [stocks, located, lots] = await Promise.all([
    prisma.warehouseStock.findMany({
      include: {
        tenant: { select: { slug: true } },
        warehouse: { select: { code: true } },
        product: { select: { code: true, lotTracking: true } },
      },
    }),
    prisma.locationStock.groupBy({ by: ['productId', 'warehouseId'], _sum: { quantity: true } }),
    prisma.lotStock.groupBy({ by: ['productId', 'warehouseId'], _sum: { quantity: true } }),
  ]);
  const sumOf = (rows: typeof located, productId: string, warehouseId: string) =>
    rows.find((row) => row.productId === productId && row.warehouseId === warehouseId)?._sum.quantity ?? 0;

  const problems: Problem[] = [];
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

  console.log(`Revisados ${stocks.length} saldos de stock.`);
  if (problems.length === 0) {
    console.log('Sin inconsistencias.');
    return;
  }
  console.table(problems);
  process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
