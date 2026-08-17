import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { NodeTreeModule } from '../nodes/node-tree.module';
import { DataRoomsController } from './data-rooms.controller';
import { DataRoomsService } from './data-rooms.service';

@Module({
  imports: [NodeTreeModule, AccessModule],
  controllers: [DataRoomsController],
  providers: [DataRoomsService],
  exports: [DataRoomsService],
})
export class DataRoomsModule {}
