import { Injectable, OnModuleInit } from '@nestjs/common';
import { JobRegistry } from '../jobs/job-registry';
import { PrismaService } from '../prisma/prisma.service';
import { checkStockIntegrity } from './stock-integrity';

export const STOCK_INTEGRITY_JOB = 'stock.integrity-check';

@Injectable()
export class StockIntegrityJob implements OnModuleInit {
  constructor(
    private registry: JobRegistry,
    private prisma: PrismaService,
  ) {}

  onModuleInit() {
    this.registry.register(STOCK_INTEGRITY_JOB, {
      maxAttempts: 2,
      handler: async (_payload, context) => {
        await context.progress(10, 'Revisando saldos de stock');
        const { checked, problems } = await checkStockIntegrity(this.prisma);
        return { checked, problems: problems.map(({ warehouse, product, issue }) => ({ warehouse, product, issue })) };
      },
    });
  }
}
