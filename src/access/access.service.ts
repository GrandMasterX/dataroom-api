import { Injectable } from '@nestjs/common';
import type { AccessContext } from '../auth/access-context';
import { DomainError } from '../common/errors/domain-error';
import type { NodeRow } from '../nodes/node-tree.service';
import { NodeTreeService } from '../nodes/node-tree.service';
import { PrismaService } from '../prisma/prisma.service';
import { can, highestRole, type Action, type Role } from './permissions';

export interface ResolvedAccess {
  node: NodeRow;
  role: Role;
  /**
   * The subtree this actor may see: the whole room for an owner, the shared node for a
   * guest. Read responses are projected against it so nothing above it — an ancestor's name
   * or id — reaches the client.
   */
  accessRoot: { id: string; path: string };
}

/**
 * Answers "may this actor touch this node", for every endpoint.
 *
 * Three rules that are easy to get backwards, and expensive when they are:
 *
 *  - **No access on a read is 404, not 403.** A 403 confirms the resource exists. In a data
 *    room, confirming that a document exists is itself disclosure — it tells an outsider
 *    which deals are in progress. 403 is reserved for "you may read this but not change
 *    it", where existence is already known to the caller.
 *  - **The ancestor test walks `parent_id`, not `path`.** `path` is a derived column
 *    maintained by the application; if the access boundary were computed from it, a bug in
 *    path maintenance would be privilege escalation rather than a display defect. Walking
 *    the real edges costs one indexed recursive query bounded by the depth limit, and moves
 *    that failure to the harmless side.
 *  - **A session and a share token can both be present.** Someone signed in to their own
 *    account may open a public link to a different data room. Every applicable grant is
 *    considered and the most permissive role wins, so the rule needs no re-deciding when
 *    EDITOR arrives.
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
   * The two failure modes stay distinct: no access at all is indistinguishable from "does
   * not exist", while insufficient permission on something already visible is reported
   * plainly so the interface can explain it.
   */
  async require(ctx: AccessContext, nodeId: string, action: Action): Promise<ResolvedAccess> {
    const resolved = await this.requireRead(ctx, nodeId);
    if (!can(action, resolved.role)) {
      throw DomainError.forbidden('You have read-only access to this item');
    }
    return resolved;
  }

  /** Data-room level check, for endpoints addressed by room rather than by node. */
  async requireRoom(
    ctx: AccessContext,
    dataRoomId: string,
    action: Action,
  ): Promise<ResolvedAccess> {
    const room = await this.prisma.dataRoom.findUnique({
      where: { id: dataRoomId },
      select: { rootNodeId: true },
    });
    if (!room?.rootNodeId) throw DomainError.notFound('Data room not found');
    return this.require(ctx, room.rootNodeId, action);
  }

  private async resolve(
    ctx: AccessContext,
    node: NodeRow,
  ): Promise<ResolvedAccess | undefined> {
    const room = await this.prisma.dataRoom.findUnique({
      where: { id: node.dataRoomId },
      select: { ownerId: true, rootNodeId: true, rootNode: { select: { path: true } } },
    });
    if (!room?.rootNodeId || !room.rootNode) return undefined;

    if (ctx.user && room.ownerId === ctx.user.id) {
      return {
        node,
        role: 'OWNER',
        accessRoot: { id: room.rootNodeId, path: room.rootNode.path },
      };
    }

    const shares = await this.applicableShares(ctx, node.dataRoomId);
    if (shares.length === 0) return undefined;

    const reachable = await this.ancestorsOrSelf(
      node.id,
      shares.map((share) => share.nodeId),
    );
    const matching = shares.filter((share) => reachable.has(share.nodeId));
    const role = highestRole(matching.map((share) => share.role));
    if (!role) return undefined;

    // The narrowest matching share defines what the guest may see. With nested shares the
    // deepest one is the most specific, and using it keeps the visible subtree as small as
    // the sharing actually justifies.
    const accessRootId = matching.reduce((deepest, share) =>
      share.nodePath.length > deepest.nodePath.length ? share : deepest,
    );

    return {
      node,
      role,
      accessRoot: { id: accessRootId.nodeId, path: accessRootId.nodePath },
    };
  }

  /**
   * Shares that could apply to this room for this actor: an unexpired, unrevoked link whose
   * token was presented, plus every live grant issued to the signed-in address.
   *
   * Revocation and expiry are evaluated here, on every request, and never cached in a
   * session. "Revoke" that leaves an open session working is a failed requirement, not a
   * delay.
   */
  private async applicableShares(
    ctx: AccessContext,
    dataRoomId: string,
  ): Promise<{ nodeId: string; nodePath: string; role: Role }[]> {
    const now = new Date();
    const shares: { nodeId: string; nodePath: string; role: Role }[] = [];

    if (ctx.shareToken) {
      const link = await this.prisma.shareLink.findUnique({
        where: { token: ctx.shareToken },
        include: { node: { select: { path: true, dataRoomId: true } } },
      });
      if (
        link &&
        link.dataRoomId === dataRoomId &&
        link.revokedAt === null &&
        (link.expiresAt === null || link.expiresAt > now)
      ) {
        shares.push({ nodeId: link.nodeId, nodePath: link.node.path, role: link.role });
      }
    }

    if (ctx.user) {
      const grants = await this.prisma.shareGrant.findMany({
        where: { dataRoomId, inviteeEmail: ctx.user.email, revokedAt: null },
        include: { node: { select: { path: true } } },
      });
      for (const grant of grants) {
        shares.push({ nodeId: grant.nodeId, nodePath: grant.node.path, role: grant.role });
      }
    }

    return shares;
  }

  /**
   * Which of `candidateIds` are the node itself or one of its ancestors, walking real
   * parent edges.
   *
   * One recursive query, bounded by the depth limit and following the primary key at each
   * step. Deliberately not a `path LIKE` test: see the class comment.
   */
  private async ancestorsOrSelf(nodeId: string, candidateIds: string[]): Promise<Set<string>> {
    if (candidateIds.length === 0) return new Set();

    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      WITH RECURSIVE chain AS (
        SELECT id, parent_id FROM nodes WHERE id = ${nodeId}::uuid
        UNION ALL
        SELECT n.id, n.parent_id FROM nodes n JOIN chain c ON n.id = c.parent_id
      )
      SELECT id FROM chain WHERE id = ANY(${candidateIds}::uuid[])`;

    return new Set(rows.map((row) => row.id));
  }
}
