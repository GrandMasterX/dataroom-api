import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { NodeTreeModule } from '../nodes/node-tree.module';
import { StorageModule } from '../storage/storage.module';
import { FilesController } from './files.controller';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';

@Module({
  imports: [NodeTreeModule, AccessModule, StorageModule],
  controllers: [UploadsController, FilesController],
  providers: [UploadsService],
  exports: [UploadsService],
})
export class UploadsModule {}
