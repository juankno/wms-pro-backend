import { Module } from '@nestjs/common';
import { PickingService } from './picking.service';
import { PickingController } from './picking.controller';
import { StockModule } from '../stock/stock.module';
import { UploadsModule } from '../uploads/uploads.module';

@Module({
  imports: [StockModule, UploadsModule],
  providers: [PickingService],
  controllers: [PickingController],
  exports: [PickingService],
})
export class PickingModule {}
