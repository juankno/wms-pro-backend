import { Module } from '@nestjs/common';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';
import { OBJECT_STORAGE } from './storage/object-storage';
import { createObjectStorage } from './storage/storage.factory';

@Module({
  providers: [UploadsService, { provide: OBJECT_STORAGE, useFactory: () => createObjectStorage() }],
  controllers: [UploadsController],
  exports: [UploadsService],
})
export class UploadsModule {}
