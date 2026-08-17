import { Module, forwardRef } from '@nestjs/common';
import { NodesModule } from '../nodes/nodes.module';
import { AccessService } from './access.service';

@Module({
  imports: [forwardRef(() => NodesModule)],
  providers: [AccessService],
  exports: [AccessService],
})
export class AccessModule {}
