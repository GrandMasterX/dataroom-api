import { randomUUID } from 'node:crypto';
import { buildChildPath } from '../../src/nodes/node-path';
import { expectUniqueViolation } from './expect-unique-violation';
import { addVersion, createNode, createRoom } from './fixtures';
import { prisma } from './setup';

/**
 * Pins the guarantees the schema itself provides. Each case names the mutation that must
 * turn it red, because a test that stays green on broken code reports safety it does not
 * provide.
 *
 * What this suite cannot detect: real S3 CORS behaviour (MinIO permits every origin) and
 * anything about the HTTP layer — those live in their own suites.
 */
describe('database guarantees', () => {
  describe('name_ci is owned by the database', () => {
    it('lowercases with PostgreSQL semantics, not JavaScript ones', async () => {
      // Mutation: drop the trigger -> name_ci stays '' and this fails.
      // The Turkish dotted capital I is the case that separates the two implementations:
      // PG yields 'istanbul.pdf', JS toLowerCase() yields 'i̇stanbul.pdf' (i + U+0307).
      const room = await createRoom();
      const node = await createNode({
        room,
        parentId: room.rootId,
        parentPath: room.rootPath,
        name: 'İSTANBUL.pdf',
        type: 'FILE',
      });

      const stored = await prisma.node.findUniqueOrThrow({
        where: { id: node.id },
        select: { nameCi: true },
      });

      expect(stored.nameCi).toBe('istanbul.pdf');
      expect(stored.nameCi).not.toBe('İSTANBUL.pdf'.toLowerCase());
    });

    it('rejects a name that differs only in case', async () => {
      // Mutation: drop the unique index -> two rows are accepted and this fails.
      const room = await createRoom();
      await createNode({
        room,
        parentId: room.rootId,
        parentPath: room.rootPath,
        name: 'Doc.pdf',
        type: 'FILE',
      });

      await expectUniqueViolation(
        createNode({
          room,
          parentId: room.rootId,
          parentPath: room.rootPath,
          name: 'DOC.PDF',
          type: 'FILE',
        }),
        'nodes_parent_id_name_ci_key',
      );
    });
  });

  describe('conflict-tolerant name allocation', () => {
    it('allocates the next free name inside one transaction', async () => {
      // This is the mechanism the upload and rename flows depend on. The obvious
      // alternative — insert, catch the violation, retry — cannot work: the first
      // violation aborts the whole PostgreSQL transaction and nothing commits.
      // Mutation: replace ON CONFLICT DO NOTHING with a plain insert -> the second
      // statement raises and the transaction dies.
      const room = await createRoom();
      await createNode({
        room,
        parentId: room.rootId,
        parentPath: room.rootPath,
        name: 'Doc.pdf',
        type: 'FILE',
      });

      const inserted = await prisma.$transaction(async (tx) => {
        const names: string[] = [];
        for (const candidate of ['Doc.pdf', 'Doc (2).pdf']) {
          const id = randomUUID();
          const rows = await tx.$queryRaw<{ name: string }[]>`
            INSERT INTO nodes (id, data_room_id, parent_id, type, name, path, depth, created_by_id)
            VALUES (${id}::uuid, ${room.roomId}::uuid, ${room.rootId}::uuid, 'FILE',
                    ${candidate}, ${buildChildPath(room.rootPath, id)}, 1, ${room.ownerId}::uuid)
            ON CONFLICT (parent_id, name_ci) DO NOTHING
            RETURNING name`;
          if (rows[0]) names.push(rows[0].name);
        }
        return names;
      });

      expect(inserted).toEqual(['Doc (2).pdf']);

      const stored = await prisma.node.findMany({
        where: { type: 'FILE' },
        select: { name: true },
        orderBy: { nameCi: 'asc' },
      });
      expect(stored.map((n) => n.name)).toEqual(['Doc (2).pdf', 'Doc.pdf']);
    });
  });

  describe('structural constraints', () => {
    it('rejects a path without the surrounding slashes', async () => {
      // Mutation: drop nodes_path_shape -> prefix scans start matching sibling subtrees.
      const room = await createRoom();
      await expect(
        createNode({
          room,
          parentId: room.rootId,
          parentPath: room.rootPath,
          name: 'bad.pdf',
          type: 'FILE',
          pathOverride: 'no-slashes',
        }),
      ).rejects.toThrow(/nodes_path_shape/);
    });

    it('rejects nesting past the depth limit', async () => {
      const room = await createRoom();
      await expect(
        createNode({
          room,
          parentId: room.rootId,
          parentPath: room.rootPath,
          name: 'deep.pdf',
          type: 'FILE',
          depthOverride: 33,
        }),
      ).rejects.toThrow(/nodes_depth_bounds/);
    });

    it('rejects a second root in the same data room', async () => {
      // Mutation: drop nodes_single_root_key -> a room silently splits in two.
      const room = await createRoom();
      const strayId = randomUUID();
      await expectUniqueViolation(
        prisma.node.create({
          data: {
            id: strayId,
            dataRoomId: room.roomId,
            parentId: null,
            type: 'FOLDER',
            name: 'Second root',
            path: `/${strayId}/`,
            depth: 0,
            createdById: room.ownerId,
          },
        }),
        'nodes_single_root_key',
      );
    });

    it('rejects a second current version of one file', async () => {
      const room = await createRoom();
      const file = await createNode({
        room,
        parentId: room.rootId,
        parentPath: room.rootPath,
        name: 'contract.pdf',
        type: 'FILE',
      });
      await addVersion({ nodeId: file.id, createdById: room.ownerId, versionNumber: 1 });

      await expectUniqueViolation(
        addVersion({
          nodeId: file.id,
          createdById: room.ownerId,
          versionNumber: 2,
          isCurrent: true,
        }),
        'file_versions_one_current',
      );
    });
  });

  describe('cascade', () => {
    it('removes the whole subtree and every version, current or not', async () => {
      // Mutation: remove onDelete: Cascade from the parent relation -> deleting a folder
      // leaves dangling nodes that are invisible in the UI but still counted in totals
      // and returned by search.
      const room = await createRoom();
      const folder = await createNode({
        room,
        parentId: room.rootId,
        parentPath: room.rootPath,
        name: 'Financials',
        type: 'FOLDER',
      });
      const nested = await createNode({
        room,
        parentId: folder.id,
        parentPath: folder.path,
        name: 'Q1',
        type: 'FOLDER',
      });
      const file = await createNode({
        room,
        parentId: nested.id,
        parentPath: nested.path,
        name: 'accounts.pdf',
        type: 'FILE',
      });
      await addVersion({ nodeId: file.id, createdById: room.ownerId, versionNumber: 1 });
      await addVersion({
        nodeId: file.id,
        createdById: room.ownerId,
        versionNumber: 2,
        isCurrent: false,
      });

      await prisma.node.delete({ where: { id: folder.id } });

      expect(await prisma.node.count({ where: { dataRoomId: room.roomId } })).toBe(1); // root only
      expect(await prisma.fileVersion.count()).toBe(0);
    });
  });
});
