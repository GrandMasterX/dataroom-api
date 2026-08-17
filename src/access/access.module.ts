import { Module } from '@nestjs/common';
import { NodeTreeModule } from '../nodes/node-tree.module';
import { AccessService } from './access.service';

@Module({
  imports: [NodeTreeModule],
  providers: [AccessService],
  exports: [AccessService],
})
export class AccessModule {}
