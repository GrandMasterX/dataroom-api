import { Module, forwardRef } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { NodeTreeService } from './node-tree.service';
import { NodesController } from './nodes.controller';

@Module({
  // AccessService depends on NodeTreeService, and this module needs AccessService for its
  // controller: a genuine cycle between two collaborators, resolved the way Nest expects.
  imports: [forwardRef(() => AccessModule)],
  controllers: [NodesController],
  providers: [NodeTreeService],
  exports: [NodeTreeService],
})
export class NodesModule {}
