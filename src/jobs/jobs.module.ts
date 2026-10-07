import { Global, Module } from '@nestjs/common';
import { JobRegistry } from './job-registry';
import { JobWorker } from './job-worker';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';

// Global so any module can register job types and enqueue work.
@Global()
@Module({
  providers: [JobRegistry, JobsService, JobWorker],
  controllers: [JobsController],
  exports: [JobRegistry, JobsService],
})
export class JobsModule {}
