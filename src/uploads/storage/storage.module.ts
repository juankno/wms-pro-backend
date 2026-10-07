import { Global, Module } from '@nestjs/common';
import { OBJECT_STORAGE, PRIVATE_STORAGE } from './object-storage';
import { createObjectStorage, createPrivateStorage } from './storage.factory';

@Global()
@Module({
  providers: [
    { provide: OBJECT_STORAGE, useFactory: () => createObjectStorage() },
    { provide: PRIVATE_STORAGE, useFactory: () => createPrivateStorage() },
  ],
  exports: [OBJECT_STORAGE, PRIVATE_STORAGE],
})
export class StorageModule {}
