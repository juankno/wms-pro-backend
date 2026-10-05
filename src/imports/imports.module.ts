import { Module } from '@nestjs/common';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';

@Module({
  providers: [ImportsService],
  controllers: [ImportsController],
})
export class ImportsModule {}
