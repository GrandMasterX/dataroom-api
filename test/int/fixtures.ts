import { randomUUID } from 'node:crypto';
import { buildChildPath, buildRootPath, depthFromPath } from '../../src/nodes/node-path';
import { prisma } from './setup';

/** Minimal builders so each test reads as the behaviour it pins, not as setup noise. */

export async function createUser(email = `u-${randomUUID()}@test`): Promise<{ id: string; email: string }> {
  return prisma.user.create({
    data: { email, passwordHash: 'not-a-real-hash', displayName: 'Test User' },
    select: { id: true, email: true },
  });
}

export interface RoomFixture {
  roomId: string;
  rootId: string;
  rootPath: string;
  ownerId: string;
}

export async function createRoom(name = 'Test Room'): Promise<RoomFixture> {
  const owner = await createUser();
  const rootId = randomUUID();
  const rootPath = buildRootPath(rootId);

  const room = await prisma.$transaction(async (tx) => {
    const created = await tx.dataRoom.create({ data: { ownerId: owner.id } });
    await tx.node.create({
      data: {
        id: rootId,
        dataRoomId: created.id,
        parentId: null,
        type: 'FOLDER',
        name,
        path: rootPath,
        depth: depthFromPath(rootPath),
        createdById: owner.id,
      },
    });
    return tx.dataRoom.update({ where: { id: created.id }, data: { rootNodeId: rootId } });
  });

  return { roomId: room.id, rootId, rootPath, ownerId: owner.id };
}

export async function createNode(params: {
  room: RoomFixture;
  parentId: string;
  parentPath: string;
  name: string;
  type: 'FOLDER' | 'FILE';
  depthOverride?: number;
  pathOverride?: string;
}): Promise<{ id: string; path: string }> {
  const id = randomUUID();
  const path = params.pathOverride ?? buildChildPath(params.parentPath, id);
  await prisma.node.create({
    data: {
      id,
      dataRoomId: params.room.roomId,
      parentId: params.parentId,
      type: params.type,
      name: params.name,
      path,
      depth: params.depthOverride ?? depthFromPath(path),
      createdById: params.room.ownerId,
    },
  });
  return { id, path };
}

export async function addVersion(params: {
  nodeId: string;
  createdById: string;
  versionNumber?: number;
  isCurrent?: boolean;
  sizeBytes?: number;
}): Promise<string> {
  const version = await prisma.fileVersion.create({
    data: {
      nodeId: params.nodeId,
      versionNumber: params.versionNumber ?? 1,
      isCurrent: params.isCurrent ?? true,
      sizeBytes: BigInt(params.sizeBytes ?? 1024),
      mimeType: 'application/pdf',
      storageKey: `rooms/test/${params.nodeId}/${randomUUID()}`,
      createdById: params.createdById,
    },
    select: { id: true },
  });
  return version.id;
}
