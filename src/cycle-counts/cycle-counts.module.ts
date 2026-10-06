import { Module } from '@nestjs/common';
import { CycleCountsController } from './cycle-counts.controller';
import { CycleCountsService } from './cycle-counts.service';

@Module({
  providers: [CycleCountsService],
  controllers: [CycleCountsController],
})
export class CycleCountsModule {}
