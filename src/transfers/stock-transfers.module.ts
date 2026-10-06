import { Module } from '@nestjs/common';
import { StockTransfersController } from './stock-transfers.controller';
import { StockTransfersService } from './stock-transfers.service';

@Module({
  providers: [StockTransfersService],
  controllers: [StockTransfersController],
})
export class StockTransfersModule {}
