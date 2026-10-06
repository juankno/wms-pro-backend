import { Module } from '@nestjs/common';
import { LabelsController } from './labels.controller';
import { LabelsService } from './labels.service';

@Module({
  providers: [LabelsService],
  controllers: [LabelsController],
})
export class LabelsModule {}
