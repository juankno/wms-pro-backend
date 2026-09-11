import { Module } from '@nestjs/common';
import { PackingService } from './packing.service';
import { PackingController } from './packing.controller';
import { StockModule } from '../stock/stock.module';
import { UploadsModule } from '../uploads/uploads.module';

@Module({
  imports: [StockModule, UploadsModule],
  providers: [PackingService],
  controllers: [PackingController],
  exports: [PackingService],
})
export class PackingModule {}
