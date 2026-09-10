import { Module } from '@nestjs/common';
import { PickingService } from './picking.service';
import { PickingController } from './picking.controller';
import { StockModule } from '../stock/stock.module';

@Module({
  imports: [StockModule],
  providers: [PickingService],
  controllers: [PickingController],
  exports: [PickingService],
})
export class PickingModule {}
