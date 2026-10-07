import { PrismaClient } from '@prisma/client';
import { checkStockIntegrity } from '../src/stock/stock-integrity';

// Read-only check of the stock invariants across every tenant; exits with 1 if any is broken.
const prisma = new PrismaClient();

async function main() {
  const { checked, problems } = await checkStockIntegrity(prisma);
  console.log(`Revisados ${checked} saldos de stock.`);
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
