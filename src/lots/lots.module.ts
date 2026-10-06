import { Module } from '@nestjs/common';
import { LotsController } from './lots.controller';
import { LotsService } from './lots.service';

@Module({
  providers: [LotsService],
  controllers: [LotsController],
})
export class LotsModule {}
