import { Injectable } from '@nestjs/common';
import type { AccessContext } from '../auth/access-context';
import { DomainError } from '../common/errors/domain-error';
import type { NodeRow } from '../nodes/node-tree.service';
import { NodeTreeService } from '../nodes/node-tree.service';
import { PrismaService } from '../prisma/prisma.service';
import { can, type Action, type Role } from './permissions';

export interface ResolvedAccess {
  node: NodeRow;
  role: Role;
  /**
   * The subtree this actor may see. For an owner it is the whole data room; for a guest it
   * will be the shared node's subtree. Read responses are projected against it so that
   * nothing above it — an ancestor's name, its id — reaches the client.
   */
  accessRoot: { id: string; path: string };
}

/**
 * Answers "may this actor touch this node", for every endpoint.
 *
 * Two rules that are easy to get backwards, and expensive when they are:
 *
 *  - **No access on a read is 404, not 403.** A 403 confirms the resource exists. In a data
 *    room, confirming that a document exists is itself disclosure — it tells an outsider
 *    which deals are in progress. 403 is reserved for "you may read this but not change
 *    it", where existence is already known to the caller.
 *  - **Role decides the action, not the endpoint.** Controllers ask for an action; they
 *    never branch on who the actor is.
 */
@Injectable()
export class AccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tree: NodeTreeService,
  ) {}

  /** Resolves read access, or throws 404 if the actor may not see the node at all. */
  async requireRead(ctx: AccessContext, nodeId: string): Promise<ResolvedAccess> {
    const node = await this.tree.requireNode(nodeId);
    const resolved = await this.resolve(ctx, node);
    if (!resolved) throw DomainError.notFound('Item not found');
    return resolved;
  }

  /**
   * Resolves access and checks that the role permits the action.
   *
   * The two failure modes are distinct on purpose: no access at all is indistinguishable
   * from "does not exist", while insufficient permission on something the actor can already
   * see is reported plainly so the UI can explain it.
   */
  async require(ctx: AccessContext, nodeId: string, action: Action): Promise<ResolvedAccess> {
    const resolved = await this.requireRead(ctx, nodeId);
    if (!can(action, resolved.role)) {
      throw DomainError.forbidden('You have read-only access to this item');
    }
    return resolved;
  }

  /** Data-room level check, used by endpoints addressed by room rather than by node. */
  async requireRoom(ctx: AccessContext, dataRoomId: string, action: Action): Promise<ResolvedAccess> {
    const room = await this.prisma.dataRoom.findUnique({
      where: { id: dataRoomId },
      select: { rootNodeId: true },
    });
    if (!room?.rootNodeId) throw DomainError.notFound('Data room not found');
    return this.require(ctx, room.rootNodeId, action);
  }

  private async resolve(ctx: AccessContext, node: NodeRow): Promise<ResolvedAccess | undefined> {
    if (ctx.user) {
      const room = await this.prisma.dataRoom.findUnique({
        where: { id: node.dataRoomId },
        select: { ownerId: true, rootNodeId: true, rootNode: { select: { path: true } } },
      });

      if (room?.ownerId === ctx.user.id && room.rootNodeId && room.rootNode) {
        return {
          node,
          role: 'OWNER',
          accessRoot: { id: room.rootNodeId, path: room.rootNode.path },
        };
      }
    }

    // Share links and per-user grants resolve here as well; both produce the same shape,
    // with accessRoot set to the shared node so read projection can truncate against it.
    return undefined;
  }
}
