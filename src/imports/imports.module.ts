import { Module } from '@nestjs/common';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';
import { ImportJobsService } from './import-jobs.service';

@Module({
  providers: [ImportsService, ImportJobsService],
  controllers: [ImportsController],
})
export class ImportsModule {}
