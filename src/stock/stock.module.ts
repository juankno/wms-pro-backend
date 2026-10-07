import { Module } from '@nestjs/common';
import { StockService } from './stock.service';
import { StockIntegrityJob } from './stock-integrity.job';
import { StockController } from './stock.controller';

@Module({
  providers: [StockService, StockIntegrityJob],
  controllers: [StockController],
  exports: [StockService],
})
export class StockModule {}
