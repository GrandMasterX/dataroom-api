import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service';

/** Global: the deletion drain and the upload flow both need it, from different modules. */
@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
