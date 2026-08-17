import { Injectable } from '@nestjs/common';
import { DomainError } from '../common/errors/domain-error';
import { NodeTreeService } from '../nodes/node-tree.service';
import { PrismaService } from '../prisma/prisma.service';

export interface DataRoomSummary {
  id: string;
  name: string;
  rootNodeId: string;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class DataRoomsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tree: NodeTreeService,
  ) {}

  async create(ownerId: string, name: string): Promise<DataRoomSummary> {
    const { dataRoomId, root } = await this.tree.createDataRoom({ ownerId, name });
    return {
      id: dataRoomId,
      name: root.name,
      rootNodeId: root.id,
      createdAt: root.updatedAt,
      updatedAt: root.updatedAt,
    };
  }

  async listOwned(ownerId: string): Promise<DataRoomSummary[]> {
    const rooms = await this.prisma.dataRoom.findMany({
      where: { ownerId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        rootNodeId: true,
        createdAt: true,
        updatedAt: true,
        rootNode: { select: { name: true } },
      },
    });

    // A room without a root would be a half-created room; the creation transaction makes
    // that impossible, so filtering here is a guard, not an expected case.
    return rooms
      .filter((room) => room.rootNodeId && room.rootNode)
      .map((room) => ({
        id: room.id,
        name: room.rootNode?.name as string,
        rootNodeId: room.rootNodeId as string,
        createdAt: room.createdAt,
        updatedAt: room.updatedAt,
      }));
  }

  async get(dataRoomId: string): Promise<DataRoomSummary> {
    const room = await this.prisma.dataRoom.findUnique({
      where: { id: dataRoomId },
      select: {
        id: true,
        rootNodeId: true,
        createdAt: true,
        updatedAt: true,
        rootNode: { select: { name: true } },
      },
    });
    if (!room?.rootNodeId || !room.rootNode) throw DomainError.notFound('Data room not found');

    return {
      id: room.id,
      name: room.rootNode.name,
      rootNodeId: room.rootNodeId,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
    };
  }

  /**
   * Deletes a room by deleting its root subtree, so the storage keys are queued by exactly
   * the same code that handles deleting a folder. A separate room-deletion path would be a
   * second place to remember about blobs — and the one nobody would remember.
   */
  async remove(dataRoomId: string): Promise<{ deletedItems: number }> {
    const room = await this.get(dataRoomId);
    const result = await this.tree.deleteSubtree(room.rootNodeId);
    await this.prisma.dataRoom.delete({ where: { id: dataRoomId } });
    return { deletedItems: result.deletedNodes };
  }
}
