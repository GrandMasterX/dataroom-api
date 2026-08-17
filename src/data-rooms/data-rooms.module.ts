import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { NodesModule } from '../nodes/nodes.module';
import { DataRoomsController } from './data-rooms.controller';
import { DataRoomsService } from './data-rooms.service';

@Module({
  imports: [NodesModule, AccessModule],
  controllers: [DataRoomsController],
  providers: [DataRoomsService],
  exports: [DataRoomsService],
})
export class DataRoomsModule {}
