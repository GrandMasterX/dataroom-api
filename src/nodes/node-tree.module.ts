import { Module } from '@nestjs/common';
import { NodeTreeService } from './node-tree.service';

/**
 * The tree domain on its own, with no knowledge of permissions.
 *
 * Keeping it separate from the controllers is what removes the module cycle: access
 * resolution needs the tree, and the controllers need access resolution, so if the tree and
 * the controllers lived together the two modules would depend on each other. A forwardRef
 * hides that at runtime but leaves the code genuinely circular — enough to break tools that
 * load the source directly.
 */
@Module({
  providers: [NodeTreeService],
  exports: [NodeTreeService],
})
export class NodeTreeModule {}
