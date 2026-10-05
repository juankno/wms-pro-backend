import { Module } from '@nestjs/common';
import { PickingModule } from '../picking/picking.module';
import { WavesController } from './waves.controller';
import { WavesService } from './waves.service';

@Module({
  imports: [PickingModule],
  providers: [WavesService],
  controllers: [WavesController],
})
export class WavesModule {}
