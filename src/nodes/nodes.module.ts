import { Module } from '@nestjs/common';
import { NodeTreeService } from './node-tree.service';

@Module({
  providers: [NodeTreeService],
  exports: [NodeTreeService],
})
export class NodesModule {}
