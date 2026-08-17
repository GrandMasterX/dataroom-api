import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DomainError } from '../common/errors/domain-error';
import { isUniqueViolation, UniqueIndex } from '../common/errors/prisma-error';
import { PrismaService, type PrismaTransaction } from '../prisma/prisma.service';
import { NAME_ATTEMPT_LIMIT, nameForAttempt, type ConflictStrategy } from './name-conflict';
import {
  MAX_DEPTH,
  buildChildPath,
  buildRootPath,
  depthFromPath,
  isInSubtree,
} from './node-path';

export type NodeType = 'FOLDER' | 'FILE';

export interface NodeRow {
  id: string;
  dataRoomId: string;
  parentId: string | null;
  type: NodeType;
  name: string;
  path: string;
  depth: number;
  updatedAt: Date;
}

export interface SubtreeStats {
  folderCount: number;
  fileCount: number;
  /** Sum of current versions only — the logical size, which is what a user sees listed. */
  totalSizeBytes: number;
}

export interface SearchHit {
  id: string;
  name: string;
  type: NodeType;
  updatedAt: Date;
  sizeBytes: number | null;
  mimeType: string | null;
  /** The folder it sits in, so a result is meaningful without showing the whole path. */
  parentId: string | null;
  parentName: string | null;
}

export interface ListedNode {
  id: string;
  name: string;
  type: NodeType;
  updatedAt: Date;
  sizeBytes: number | null;
  mimeType: string | null;
}

/**
 * Everything that changes the shape of the tree.
 *
 * This is the only place that writes `parent_id`, `path` and `depth`. `path` is derived
 * from `parent_id`, so a second writer would eventually disagree with the first — and a
 * wrong `path` means subtree queries return a silently wrong set of rows rather than an
 * error.
 *
 * Two different concurrency strategies are used, and the difference is deliberate:
 *
 *  - **Inserts** (new folder, uploaded file) allocate their name with
 *    `INSERT ... ON CONFLICT DO NOTHING RETURNING`, which needs no lock. Taking a
 *    room-wide lock per uploaded file would turn a 20-file drag-and-drop into a queue.
 *  - **Updates of an existing row** (rename, move) take the per-room advisory lock and
 *    compute a free name first. They cannot use ON CONFLICT — an `UPDATE` that violates a
 *    unique index aborts the whole transaction, and there is no upsert form for it. Move
 *    needs the lock regardless, because without it "move A into B" and "move B into A" can
 *    both pass validation and produce a detached cycle.
 */
@Injectable()
export class NodeTreeService {
  constructor(private readonly prisma: PrismaService) {}

  /** Creates a data room and its root node. The room's name is the root node's name. */
  async createDataRoom(params: {
    ownerId: string;
    name: string;
  }): Promise<{ dataRoomId: string; root: NodeRow }> {
    const rootId = randomUUID();
    const path = buildRootPath(rootId);

    return this.prisma.$transaction(async (tx) => {
      const room = await tx.dataRoom.create({ data: { ownerId: params.ownerId } });
      const root = await tx.node.create({
        data: {
          id: rootId,
          dataRoomId: room.id,
          parentId: null,
          type: 'FOLDER',
          name: params.name,
          path,
          depth: depthFromPath(path),
          createdById: params.ownerId,
        },
      });
      await tx.dataRoom.update({ where: { id: room.id }, data: { rootNodeId: rootId } });
      return { dataRoomId: room.id, root: toNodeRow(root) };
    });
  }

  async createFolder(params: {
    actorId: string;
    parentId: string;
    name: string;
    onConflict: ConflictStrategy;
  }): Promise<NodeRow> {
    const parent = await this.requireFolder(params.parentId);
    this.assertDepthWithinLimit(parent.depth + 1);

    return this.prisma.$transaction(async (tx) =>
      this.insertChild(tx, {
        parent,
        actorId: params.actorId,
        name: params.name,
        type: 'FOLDER',
        onConflict: params.onConflict,
      }),
    );
  }

  /**
   * Inserts a child, resolving a name collision without ever aborting the transaction.
   *
   * Shared by folder creation and upload completion so that both produce the same names for
   * the same collision.
   */
  async insertChild(
    tx: PrismaTransaction,
    params: {
      parent: NodeRow;
      actorId: string;
      name: string;
      type: NodeType;
      onConflict: ConflictStrategy;
      nodeId?: string;
    },
  ): Promise<NodeRow> {
    const attempts = params.onConflict === 'rename' ? NAME_ATTEMPT_LIMIT : 1;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const id = params.nodeId ?? randomUUID();
      const path = buildChildPath(params.parent.path, id);
      const candidate = nameForAttempt(params.name, attempt);

      const rows = await tx.$queryRaw<RawNode[]>`
        INSERT INTO nodes (id, data_room_id, parent_id, type, name, path, depth, created_by_id)
        VALUES (${id}::uuid, ${params.parent.dataRoomId}::uuid, ${params.parent.id}::uuid,
                ${params.type}::node_type, ${candidate}, ${path}, ${depthFromPath(path)},
                ${params.actorId}::uuid)
        ON CONFLICT (parent_id, name_ci) DO NOTHING
        RETURNING id, data_room_id, parent_id, type, name, path, depth, updated_at`;

      const inserted = rows[0];
      if (inserted) return fromRawNode(inserted);
    }

    throw DomainError.nameConflict(params.name, { parentId: params.parent.id });
  }

  async rename(params: {
    nodeId: string;
    name: string;
    onConflict: ConflictStrategy;
  }): Promise<NodeRow> {
    const node = await this.requireNode(params.nodeId);
    if (node.parentId === null) {
      // Renaming the root renames the data room; allowed, and there is no sibling to
      // collide with, so no name resolution is needed.
      return this.updateName(node, params.name);
    }

    return this.prisma.$transaction(async (tx) => {
      await this.prisma.lockDataRoomTree(tx, node.dataRoomId);
      const name = await this.resolveFreeName(tx, {
        parentId: node.parentId as string,
        desiredName: params.name,
        onConflict: params.onConflict,
        excludeNodeId: node.id,
      });

      const rows = await tx.$queryRaw<RawNode[]>`
        UPDATE nodes SET name = ${name}, updated_at = now()
        WHERE id = ${node.id}::uuid
        RETURNING id, data_room_id, parent_id, type, name, path, depth, updated_at`;
      return fromRawNode(rows[0] as RawNode);
    });
  }

  /**
   * Moves a node (with its whole subtree) into another folder.
   *
   * Runs under the room lock so that no concurrent move can invalidate the cycle check
   * between validation and the write.
   */
  async move(params: {
    nodeId: string;
    targetParentId: string;
    onConflict: ConflictStrategy;
  }): Promise<NodeRow> {
    return this.prisma.$transaction(async (tx) => {
      const node = await this.requireNode(params.nodeId, tx);
      if (node.parentId === null) {
        throw DomainError.invalidMoveTarget('A data room cannot be moved');
      }

      await this.prisma.lockDataRoomTree(tx, node.dataRoomId);

      // Re-read both rows inside the lock: anything read before it could already be stale.
      const fresh = await this.requireNode(params.nodeId, tx);
      const target = await this.requireFolder(params.targetParentId, tx);

      if (target.dataRoomId !== fresh.dataRoomId) {
        throw DomainError.invalidMoveTarget('Items cannot be moved between data rooms');
      }
      if (isInSubtree(fresh.path, target.path)) {
        // Covers both "into itself" and "into its own descendant". Without this the subtree
        // disappears from every listing while its rows remain.
        throw DomainError.invalidMoveTarget('A folder cannot be moved into itself');
      }
      if (fresh.parentId === target.id) return fresh;

      const depthDelta = target.depth + 1 - fresh.depth;
      const deepest = await this.deepestDescendantDepth(tx, fresh);
      // The limit applies to the deepest descendant, not to the moved node: otherwise a
      // 20-level folder could be dropped at level 30.
      this.assertDepthWithinLimit(deepest + depthDelta);

      const name = await this.resolveFreeName(tx, {
        parentId: target.id,
        desiredName: fresh.name,
        onConflict: params.onConflict,
        excludeNodeId: fresh.id,
      });

      const newPath = buildChildPath(target.path, fresh.id);

      await tx.$executeRaw`
        UPDATE nodes SET parent_id = ${target.id}::uuid, name = ${name}, updated_at = now()
        WHERE id = ${fresh.id}::uuid`;

      // One statement rewrites the moved node and every descendant. The offset is the
      // length of the old prefix; paths hold ids and slashes only, so byte and character
      // positions coincide.
      //
      // The ::int cast is load-bearing. `substring(text FROM ...)` is overloaded, and with
      // an untyped parameter PostgreSQL resolves it to the *regex* form
      // `substring(string FROM pattern)`. That form finds no match and returns NULL — so
      // every path becomes NULL rather than raising an error. Silent wrong data is the
      // expensive direction, and one cast removes the ambiguity.
      await tx.$executeRaw`
        UPDATE nodes
        SET path = ${newPath} || substring(path FROM ${fresh.path.length + 1}::int),
            depth = depth + ${depthDelta}::int
        WHERE data_room_id = ${fresh.dataRoomId}::uuid AND path LIKE ${`${fresh.path}%`}`;

      return this.requireNode(fresh.id, tx);
    });
  }

  /**
   * Deletes a node and everything under it.
   *
   * Storage keys are queued inside the same transaction. If the process died between the
   * commit and the object deletion, the keys would otherwise be unrecoverable — the
   * file_versions rows are gone — and a document the user deleted would stay in the bucket
   * forever. For a due-diligence product that is the worse of the two failure directions.
   */
  async deleteSubtree(nodeId: string): Promise<{ deletedNodes: number; queuedObjects: number }> {
    const node = await this.requireNode(nodeId);
    const prefix = `${node.path}%`;

    return this.prisma.$transaction(async (tx) => {
      await this.prisma.lockDataRoomTree(tx, node.dataRoomId);

      // Every version, not only the current one: a previous version's bytes are just as
      // confidential.
      const queuedObjects = await tx.$executeRaw`
        INSERT INTO pending_blob_deletions (id, storage_key)
        SELECT gen_random_uuid(), v.storage_key
        FROM nodes n JOIN file_versions v ON v.node_id = n.id
        WHERE n.data_room_id = ${node.dataRoomId}::uuid AND n.path LIKE ${prefix}`;

      // Explicit subtree delete rather than relying on recursive FK cascade: one range
      // scan, and the row count is a meaningful result to return.
      const deletedNodes = await tx.$executeRaw`
        DELETE FROM nodes
        WHERE data_room_id = ${node.dataRoomId}::uuid AND path LIKE ${prefix}`;

      return { deletedNodes, queuedObjects };
    });
  }

  /**
   * Totals for a subtree, excluding the node itself.
   *
   * The prefix is passed as a bound parameter, which matters: PostgreSQL derives the index
   * range from the parameter value, but cannot do so when the pattern is built from a
   * subquery — that form silently becomes a sequential scan.
   */
  async stats(nodeId: string): Promise<SubtreeStats> {
    const node = await this.requireNode(nodeId);

    const rows = await this.prisma.$queryRaw<
      { folder_count: bigint; file_count: bigint; total_size: bigint | null }[]
    >`
      SELECT count(*) FILTER (WHERE n.type = 'FOLDER') AS folder_count,
             count(*) FILTER (WHERE n.type = 'FILE')   AS file_count,
             sum(v.size_bytes)                          AS total_size
      FROM nodes n
      LEFT JOIN file_versions v ON v.node_id = n.id AND v.is_current
      WHERE n.data_room_id = ${node.dataRoomId}::uuid
        AND n.path LIKE ${`${node.path}%`}
        AND n.id <> ${node.id}::uuid`;

    const row = rows[0];
    return {
      folderCount: Number(row?.folder_count ?? 0),
      fileCount: Number(row?.file_count ?? 0),
      // Sizes are BigInt in the database because a column should not cap at 2 GB, but the
      // API speaks JSON, where BigInt cannot be serialised. Converting here documents the
      // boundary; the safe range (2^53 bytes ≈ 9 PB) is far beyond any real data room.
      totalSizeBytes: Number(row?.total_size ?? 0),
    };
  }

  /**
   * One page of a folder's children, ordered folders-first then by name.
   *
   * Keyset pagination, never OFFSET: OFFSET reads and discards every skipped row, and under
   * concurrent inserts it skips or repeats rows across pages. The sort tuple ends in the id
   * so ties cannot stall the scan, and the column order matches the composite index, which
   * makes this an index seek with no sort step.
   */
  async listChildren(params: {
    parentId: string;
    limit: number;
    cursor?: string;
    type?: NodeType;
  }): Promise<{ items: ListedNode[]; nextCursor?: string }> {
    const cursor = params.cursor ? decodeCursor(params.cursor) : undefined;
    const limit = Math.min(Math.max(params.limit, 1), 200);

    const rows = await this.prisma.$queryRaw<RawListedNode[]>`
      SELECT n.id, n.name, n.type, n.name_ci, n.updated_at,
             v.size_bytes, v.mime_type
      FROM nodes n
      LEFT JOIN file_versions v ON v.node_id = n.id AND v.is_current
      WHERE n.parent_id = ${params.parentId}::uuid
        AND (${params.type ?? null}::node_type IS NULL OR n.type = ${params.type ?? null}::node_type)
        AND (${cursor === undefined}
             OR (n.type, n.name_ci, n.id) >
                (${cursor?.type ?? 'FOLDER'}::node_type, ${cursor?.nameCi ?? ''}, ${cursor?.id ?? EMPTY_UUID}::uuid))
      ORDER BY n.type, n.name_ci, n.id
      LIMIT ${limit + 1}`;

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);

    return {
      items: page.map(toListedNode),
      nextCursor:
        hasMore && last
          ? encodeCursor({ type: last.type, nameCi: last.name_ci, id: last.id })
          : undefined,
    };
  }

  /**
   * Searches names inside one subtree.
   *
   * Scoped to a node rather than to a data room, which makes the same endpoint correct for
   * an owner searching a whole room and for a guest searching only what was shared with
   * them — the boundary is the node they are allowed to see, so there is no second rule to
   * write for guests and no way to widen it by changing a parameter.
   *
   * The prefix is a bound parameter: PostgreSQL derives the index range from the value, but
   * cannot when the pattern is built from a subquery, and that form silently becomes a
   * sequential scan.
   *
   * Queries shorter than three characters are rejected by the caller: fewer characters
   * produce no complete trigrams, so the GIN index cannot be used and every keystroke would
   * scan the room.
   */
  async search(params: {
    node: NodeRow;
    query: string;
    limit: number;
  }): Promise<SearchHit[]> {
    const rows = await this.prisma.$queryRaw<
      (RawListedNode & { parent_id: string | null; parent_name: string | null })[]
    >`
      SELECT n.id, n.name, n.type, n.name_ci, n.updated_at,
             v.size_bytes, v.mime_type,
             n.parent_id, p.name AS parent_name
      FROM nodes n
      LEFT JOIN file_versions v ON v.node_id = n.id AND v.is_current
      LEFT JOIN nodes p ON p.id = n.parent_id
      WHERE n.data_room_id = ${params.node.dataRoomId}::uuid
        AND n.path LIKE ${`${params.node.path}%`}
        AND n.id <> ${params.node.id}::uuid
        AND n.name_ci LIKE '%' || lower(${params.query}) || '%'
      ORDER BY n.type, n.name_ci, n.id
      LIMIT ${Math.min(Math.max(params.limit, 1), 50)}`;

    return rows.map((row) => ({
      ...toListedNode(row),
      parentId: row.parent_id,
      parentName: row.parent_name,
    }));
  }

  /**
   * Ancestors of a node, root first.
   *
   * The ids come from the node's own path, so this is one query regardless of nesting
   * depth. Walking `parent_id` in a loop would be an N+1 that grows as folders get deeper.
   */
  async breadcrumbs(node: NodeRow): Promise<{ id: string; name: string }[]> {
    const ancestorIds = node.path.split('/').filter(Boolean).slice(0, -1);
    if (ancestorIds.length === 0) return [];

    const ancestors = await this.prisma.node.findMany({
      where: { id: { in: ancestorIds } },
      select: { id: true, name: true, path: true },
    });

    // Order by path length: shorter path means closer to the root.
    return ancestors
      .sort((a, b) => a.path.length - b.path.length)
      .map(({ id, name }) => ({ id, name }));
  }

  async requireNode(nodeId: string, tx?: PrismaTransaction): Promise<NodeRow> {
    const client = tx ?? this.prisma;
    const node = await client.node.findUnique({ where: { id: nodeId } });
    // Not found and not permitted deliberately look the same to callers above this layer.
    if (!node) throw DomainError.notFound('Item not found');
    return toNodeRow(node);
  }

  private async requireFolder(nodeId: string, tx?: PrismaTransaction): Promise<NodeRow> {
    const node = await this.requireNode(nodeId, tx);
    if (node.type !== 'FOLDER') {
      throw DomainError.invalidMoveTarget('Files cannot contain other items');
    }
    return node;
  }

  /**
   * Picks the first free name among the candidates, or fails.
   *
   * Postgres does the comparison via `lower()`, not JavaScript: the two disagree on inputs
   * such as 'İSTANBUL.pdf', and comparing with the wrong one would let a duplicate through
   * to the unique index — which, mid-transaction, is fatal rather than recoverable.
   *
   * Safe only while the caller holds the room lock; without it this is a check-then-act
   * race. The two must not be separated.
   */
  private async resolveFreeName(
    tx: PrismaTransaction,
    params: {
      parentId: string;
      desiredName: string;
      onConflict: ConflictStrategy;
      excludeNodeId?: string;
    },
  ): Promise<string> {
    const attempts = params.onConflict === 'rename' ? NAME_ATTEMPT_LIMIT : 1;
    const candidates = Array.from({ length: attempts }, (_, index) =>
      nameForAttempt(params.desiredName, index + 1),
    );

    const rows = await tx.$queryRaw<{ name: string }[]>`
      SELECT c.value AS name
      FROM unnest(${candidates}::text[]) WITH ORDINALITY AS c(value, ord)
      WHERE NOT EXISTS (
        SELECT 1 FROM nodes n
        WHERE n.parent_id = ${params.parentId}::uuid
          AND n.name_ci = lower(c.value)
          AND n.id <> ${params.excludeNodeId ?? EMPTY_UUID}::uuid)
      ORDER BY c.ord
      LIMIT 1`;

    const free = rows[0]?.name;
    if (!free) throw DomainError.nameConflict(params.desiredName, { parentId: params.parentId });
    return free;
  }

  private async updateName(node: NodeRow, name: string): Promise<NodeRow> {
    try {
      const updated = await this.prisma.node.update({
        where: { id: node.id },
        data: { name },
      });
      return toNodeRow(updated);
    } catch (error) {
      if (isUniqueViolation(error, UniqueIndex.nodeNameInFolder)) {
        throw DomainError.nameConflict(name, { parentId: node.parentId });
      }
      throw error;
    }
  }

  private async deepestDescendantDepth(tx: PrismaTransaction, node: NodeRow): Promise<number> {
    const rows = await tx.$queryRaw<{ max_depth: number | null }[]>`
      SELECT max(depth) AS max_depth FROM nodes
      WHERE data_room_id = ${node.dataRoomId}::uuid AND path LIKE ${`${node.path}%`}`;
    return rows[0]?.max_depth ?? node.depth;
  }

  private assertDepthWithinLimit(depth: number): void {
    if (depth > MAX_DEPTH) throw DomainError.depthLimitExceeded(MAX_DEPTH);
  }
}

const EMPTY_UUID = '00000000-0000-0000-0000-000000000000';

interface RawNode {
  id: string;
  data_room_id: string;
  parent_id: string | null;
  type: NodeType;
  name: string;
  path: string;
  depth: number;
  updated_at: Date;
}

interface RawListedNode {
  id: string;
  name: string;
  type: NodeType;
  name_ci: string;
  updated_at: Date;
  size_bytes: bigint | null;
  mime_type: string | null;
}

function fromRawNode(row: RawNode): NodeRow {
  return {
    id: row.id,
    dataRoomId: row.data_room_id,
    parentId: row.parent_id,
    type: row.type,
    name: row.name,
    path: row.path,
    depth: row.depth,
    updatedAt: row.updated_at,
  };
}

function toNodeRow(row: {
  id: string;
  dataRoomId: string;
  parentId: string | null;
  type: string;
  name: string;
  path: string;
  depth: number;
  updatedAt: Date;
}): NodeRow {
  return { ...row, type: row.type as NodeType };
}

function toListedNode(row: RawListedNode): ListedNode {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    updatedAt: row.updated_at,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    mimeType: row.mime_type,
  };
}

interface Cursor {
  type: NodeType;
  nameCi: string;
  id: string;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(raw: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString()) as Cursor;
    if (!parsed.id || !parsed.type) throw new Error('incomplete cursor');
    return parsed;
  } catch {
    // A malformed cursor is a client bug; failing loudly beats silently returning page one,
    // which would look like an infinite list.
    throw DomainError.notFound('Invalid pagination cursor');
  }
}
