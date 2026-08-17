import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DomainError } from '../common/errors/domain-error';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { NodeTreeService, type NodeRow } from '../nodes/node-tree.service';
import {
  PrismaService,
  TREE_TRANSACTION_OPTIONS,
  type PrismaTransaction,
} from '../prisma/prisma.service';
import { buildStorageKey } from '../storage/storage-key';
import { StorageService } from '../storage/storage.service';
import { SUPPORTED_MIME_TYPES } from './supported-types';
import type {
  CompleteUploadDto,
  PresignBatchDto,
  PresignBatchResultDto,
  UploadResultDto,
} from './dto/upload.dto';

interface ConflictRow {
  requested_name: string;
  existing_node_id: string | null;
  existing_type: 'FOLDER' | 'FILE' | null;
  version_count: number | null;
}

/**
 * Upload flow: presign → the browser PUTs to S3 → complete.
 *
 * The intermediate `UploadIntent` row is what makes the rest of it honest. It records what
 * was signed, so completion can verify that the object that landed is the object that was
 * promised; it gives garbage collection an exact list of unfinished uploads instead of a
 * bucket scan; and it holds the result so a retried completion returns the same answer
 * rather than a conflict.
 */
@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly tree: NodeTreeService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async presign(actorId: string, parent: NodeRow, dto: PresignBatchDto): Promise<PresignBatchResultDto> {
    if (parent.type !== 'FOLDER') {
      throw DomainError.invalidMoveTarget('Files cannot contain other files');
    }

    for (const item of dto.items) {
      if (item.sizeBytes > this.config.uploadMaxBytes) {
        throw DomainError.fileTooLarge(this.config.uploadMaxBytes);
      }
      if (!SUPPORTED_MIME_TYPES.has(item.mimeType)) {
        throw DomainError.unsupportedMime(item.mimeType);
      }
    }

    const conflicts = await this.findConflicts(
      parent.id,
      dto.items.map((item) => item.fileName),
    );

    const expiresAt = new Date(Date.now() + this.config.presignPutTtlSeconds * 1000);

    const items = await Promise.all(
      dto.items.map(async (item) => {
        const intentId = randomUUID();
        const storageKey = buildStorageKey({
          dataRoomId: parent.dataRoomId,
          uploadIntentId: intentId,
        });

        await this.prisma.uploadIntent.create({
          data: {
            id: intentId,
            dataRoomId: parent.dataRoomId,
            parentId: parent.id,
            fileName: item.fileName,
            mimeType: item.mimeType,
            declaredSize: BigInt(item.sizeBytes),
            storageKey,
            expiresAt,
            createdById: actorId,
          },
        });

        const upload = await this.storage.presignUpload({
          key: storageKey,
          contentType: item.mimeType,
        });

        const conflict = conflicts.get(item.fileName.toLowerCase());
        return {
          intentId,
          uploadUrl: upload.url,
          contentType: upload.contentType,
          expiresAt: upload.expiresAt,
          conflict,
        };
      }),
    );

    return { items };
  }

  /**
   * Turns an uploaded object into a file (or a new version of one).
   *
   * Every check here exists because the client cannot be trusted about what it did: the
   * declared size, the destination folder still existing, and — for "add a version" — the
   * file it named still being the file at that name.
   */
  async complete(actorId: string, dto: CompleteUploadDto): Promise<UploadResultDto> {
    const intent = await this.prisma.uploadIntent.findUnique({ where: { id: dto.intentId } });
    // Deliberately 404 rather than 403 for someone else's upload: an id is not proof of
    // anything, and confirming that one exists tells an outsider a transfer is happening.
    if (!intent || intent.createdById !== actorId) throw DomainError.notFound('Upload not found');

    if (intent.consumedAt && intent.resultNodeId && intent.resultVersionId) {
      // A retry after a dropped response. Returning the same result keeps the client's
      // retry harmless; answering 409 would report a failure for an upload that succeeded.
      return this.describeResult(intent.resultNodeId, intent.resultVersionId);
    }

    if (intent.expiresAt.getTime() < Date.now()) throw DomainError.uploadIntentExpired();

    const stored = await this.storage.head(intent.storageKey);
    if (!stored) throw DomainError.uploadNotFinished();

    // The size limit cannot be enforced by the signature — see StorageService.presignUpload
    // — so it is enforced here, and the object is queued for removal because nothing will
    // ever reference it.
    if (stored.sizeBytes > this.config.uploadMaxBytes) {
      await this.discard(intent.id, intent.storageKey);
      throw DomainError.fileTooLarge(this.config.uploadMaxBytes);
    }
    if (BigInt(stored.sizeBytes) !== intent.declaredSize) {
      await this.discard(intent.id, intent.storageKey);
      throw DomainError.uploadNotFinished();
    }

    const strategy = dto.onConflict ?? 'fail';

    const result = await this.prisma.$transaction(async (tx) => {
      // The destination can be deleted between signing and completing. The intent survives
      // that (its parent reference is cleared, not cascaded away) precisely so the answer
      // can be "that folder is gone" rather than "no such upload".
      const parent = intent.parentId
        ? await tx.node.findUnique({ where: { id: intent.parentId } })
        : null;
      if (!parent) throw DomainError.gone('The destination folder no longer exists');

      if (strategy === 'newVersion') {
        return this.addVersionToExisting(tx, {
          intent: { ...intent, parentId: parent.id },
          actorId,
          stored,
        });
      }

      const node = await this.tree.insertChild(tx, {
        parent: {
          id: parent.id,
          dataRoomId: parent.dataRoomId,
          parentId: parent.parentId,
          type: 'FOLDER',
          name: parent.name,
          path: parent.path,
          depth: parent.depth,
          updatedAt: parent.updatedAt,
        },
        actorId,
        name: intent.fileName,
        type: 'FILE',
        onConflict: strategy,
      });

      const version = await tx.fileVersion.create({
        data: {
          id: intent.id,
          nodeId: node.id,
          versionNumber: 1,
          isCurrent: true,
          sizeBytes: BigInt(stored.sizeBytes),
          mimeType: intent.mimeType,
          storageKey: intent.storageKey,
          checksum: stored.etag,
          createdById: actorId,
        },
      });

      await tx.uploadIntent.update({
        where: { id: intent.id },
        data: { consumedAt: new Date(), resultNodeId: node.id, resultVersionId: version.id },
      });

      return { node, versionNumber: version.versionNumber, sizeBytes: stored.sizeBytes };
    }, TREE_TRANSACTION_OPTIONS);

    return {
      node: {
        id: result.node.id,
        dataRoomId: result.node.dataRoomId,
        parentId: result.node.parentId,
        type: result.node.type,
        name: result.node.name,
        updatedAt: result.node.updatedAt,
        sizeBytes: result.sizeBytes,
        mimeType: intent.mimeType,
      },
      versionNumber: result.versionNumber,
      sizeBytes: result.sizeBytes,
    };
  }

  /**
   * Adds a version to the file the user pointed at — after checking it is still that file.
   *
   * Between signing and completing, the owner may have renamed or moved the colliding file.
   * Without re-checking, the version would be attached to a document the user is not looking
   * at, and the current version of that document would silently change.
   */
  private async addVersionToExisting(
    tx: PrismaTransaction,
    params: {
      intent: { id: string; parentId: string; fileName: string; mimeType: string; storageKey: string };
      actorId: string;
      stored: { sizeBytes: number; etag?: string };
    },
  ): Promise<{ node: NodeRow; versionNumber: number; sizeBytes: number }> {
    const [existing] = await tx.$queryRaw<
      {
        id: string;
        data_room_id: string;
        parent_id: string | null;
        type: 'FOLDER' | 'FILE';
        name: string;
        path: string;
        depth: number;
        updated_at: Date;
      }[]
    >`
      SELECT id, data_room_id, parent_id, type, name, path, depth, updated_at
      FROM nodes
      WHERE parent_id = ${params.intent.parentId}::uuid
        AND name_ci = lower(${params.intent.fileName})`;

    if (!existing || existing.type !== 'FILE') {
      throw DomainError.nameConflict(params.intent.fileName, {
        reason: 'The file this version was meant for is no longer there',
      });
    }

    const currentMax = await tx.fileVersion.aggregate({
      where: { nodeId: existing.id },
      _max: { versionNumber: true },
    });
    const versionNumber = (currentMax._max.versionNumber ?? 0) + 1;

    // Unset first: the partial unique index allows only one current version per file, so
    // inserting before clearing would violate it.
    await tx.fileVersion.updateMany({
      where: { nodeId: existing.id, isCurrent: true },
      data: { isCurrent: false },
    });

    const version = await tx.fileVersion.create({
      data: {
        id: params.intent.id,
        nodeId: existing.id,
        versionNumber,
        isCurrent: true,
        sizeBytes: BigInt(params.stored.sizeBytes),
        mimeType: params.intent.mimeType,
        storageKey: params.intent.storageKey,
        checksum: params.stored.etag,
        createdById: params.actorId,
      },
    });

    await tx.node.update({ where: { id: existing.id }, data: { updatedAt: new Date() } });
    await tx.uploadIntent.update({
      where: { id: params.intent.id },
      data: { consumedAt: new Date(), resultNodeId: existing.id, resultVersionId: version.id },
    });

    return {
      node: {
        id: existing.id,
        dataRoomId: existing.data_room_id,
        parentId: existing.parent_id,
        type: existing.type,
        name: existing.name,
        path: existing.path,
        depth: existing.depth,
        updatedAt: existing.updated_at,
      },
      versionNumber,
      sizeBytes: params.stored.sizeBytes,
    };
  }

  /**
   * Looks up collisions for a batch of names in one query.
   *
   * The comparison uses PostgreSQL's `lower()`, matching the unique index exactly. Doing it
   * in JavaScript would disagree on inputs such as 'İSTANBUL.pdf' and report "no conflict"
   * for a name that the index will reject moments later.
   */
  private async findConflicts(
    parentId: string,
    fileNames: string[],
  ): Promise<Map<string, { existingNodeId: string; existingType: 'FOLDER' | 'FILE'; versionCount: number }>> {
    const rows = await this.prisma.$queryRaw<ConflictRow[]>`
      SELECT c.value AS requested_name,
             n.id AS existing_node_id,
             n.type AS existing_type,
             (SELECT count(*) FROM file_versions v WHERE v.node_id = n.id)::int AS version_count
      FROM unnest(${fileNames}::text[]) AS c(value)
      LEFT JOIN nodes n ON n.parent_id = ${parentId}::uuid AND n.name_ci = lower(c.value)`;

    const conflicts = new Map<
      string,
      { existingNodeId: string; existingType: 'FOLDER' | 'FILE'; versionCount: number }
    >();

    for (const row of rows) {
      if (!row.existing_node_id || !row.existing_type) continue;
      conflicts.set(row.requested_name.toLowerCase(), {
        existingNodeId: row.existing_node_id,
        existingType: row.existing_type,
        versionCount: row.version_count ?? 0,
      });
    }
    return conflicts;
  }

  /** Marks an unusable upload as finished and queues its object for removal. */
  private async discard(intentId: string, storageKey: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.pendingBlobDeletion.create({ data: { storageKey } }),
      this.prisma.uploadIntent.update({
        where: { id: intentId },
        data: { consumedAt: new Date() },
      }),
    ]);
    this.logger.warn(`Discarded upload ${intentId}: stored object did not match what was signed`);
  }

  private async describeResult(nodeId: string, versionId: string): Promise<UploadResultDto> {
    const node = await this.tree.requireNode(nodeId);
    const version = await this.prisma.fileVersion.findUniqueOrThrow({ where: { id: versionId } });
    return {
      node: {
        id: node.id,
        dataRoomId: node.dataRoomId,
        parentId: node.parentId,
        type: node.type,
        name: node.name,
        updatedAt: node.updatedAt,
        sizeBytes: Number(version.sizeBytes),
        mimeType: version.mimeType,
      },
      versionNumber: version.versionNumber,
      sizeBytes: Number(version.sizeBytes),
    };
  }
}
