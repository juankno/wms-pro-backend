import { Module } from '@nestjs/common';
import { PickingModule } from '../picking/picking.module';
import { SalesOrdersController } from './sales-orders.controller';
import { SalesOrdersService } from './sales-orders.service';

@Module({
  imports: [PickingModule],
  providers: [SalesOrdersService],
  controllers: [SalesOrdersController],
})
export class SalesModule {}
