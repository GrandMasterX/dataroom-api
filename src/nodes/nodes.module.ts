import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { NodeTreeModule } from './node-tree.module';
import { NodesController } from './nodes.controller';

@Module({
  imports: [NodeTreeModule, AccessModule],
  controllers: [NodesController],
})
export class NodesModule {}
