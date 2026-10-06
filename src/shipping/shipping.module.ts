import { Module } from '@nestjs/common';
import { ShippingController } from './shipping.controller';
import { ShippingService } from './shipping.service';

@Module({
  providers: [ShippingService],
  controllers: [ShippingController],
})
export class ShippingModule {}
