import type { INestApplication } from '@nestjs/common';
import { NodeTreeService } from '../../src/nodes/node-tree.service';
import { createTestApp } from './app.harness';
import { createUser } from './fixtures';
import { prisma } from './setup';

/**
 * Tree mechanics against a real database.
 *
 * These are integration rather than unit tests on purpose: half of what they check is a
 * property of PostgreSQL (a unique index, ON CONFLICT semantics, a prefix scan), and a
 * mocked client could only confirm what the author already assumed. Each case names the
 * mutation that must turn it red.
 */
describe('NodeTreeService', () => {
  let app: INestApplication;
  let tree: NodeTreeService;
  let ownerId: string;

  beforeAll(async () => {
    app = await createTestApp();
    tree = app.get(NodeTreeService);
  });
  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    ownerId = (await createUser()).id;
  });

  const newRoom = async (name = 'Acme Acquisition') =>
    tree.createDataRoom({ ownerId, name });

  describe('creating folders', () => {
    it('keeps both items when asked, numbering from two', async () => {
      const { root } = await newRoom();
      const first = await tree.createFolder({
        actorId: ownerId,
        parentId: root.id,
        name: 'Financials',
        onConflict: 'fail',
      });
      const second = await tree.createFolder({
        actorId: ownerId,
        parentId: root.id,
        name: 'Financials',
        onConflict: 'rename',
      });
      const third = await tree.createFolder({
        actorId: ownerId,
        parentId: root.id,
        name: 'Financials',
        onConflict: 'rename',
      });

      // Mutation: replace ON CONFLICT DO NOTHING with a plain insert -> the first conflict
      // aborts the transaction and this throws instead of producing '(2)'.
      expect([first.name, second.name, third.name]).toEqual([
        'Financials',
        'Financials (2)',
        'Financials (3)',
      ]);
    });

    it('reports a conflict instead of inventing a name when told to fail', async () => {
      const { root } = await newRoom();
      await tree.createFolder({
        actorId: ownerId,
        parentId: root.id,
        name: 'Legal',
        onConflict: 'fail',
      });

      await expect(
        tree.createFolder({
          actorId: ownerId,
          parentId: root.id,
          name: 'legal',
          onConflict: 'fail',
        }),
      ).rejects.toMatchObject({ code: 'NAME_CONFLICT' });
    });

    it('refuses to nest past the depth limit', async () => {
      const { root } = await newRoom();
      let parentId = root.id;
      // The root is depth 0, so 32 more levels reach the limit exactly.
      for (let depth = 1; depth <= 32; depth += 1) {
        const created = await tree.createFolder({
          actorId: ownerId,
          parentId,
          name: `level-${depth}`,
          onConflict: 'fail',
        });
        parentId = created.id;
      }

      await expect(
        tree.createFolder({ actorId: ownerId, parentId, name: 'too-deep', onConflict: 'fail' }),
      ).rejects.toMatchObject({ code: 'DEPTH_LIMIT_EXCEEDED' });
    });
  });

  describe('renaming', () => {
    it('changes the name and leaves the path untouched', async () => {
      // Mutation: include `path` in the rename UPDATE -> this fails. Paths hold ids, so a
      // rename must never touch them; if it does, something rebuilt the path from names.
      const { root } = await newRoom();
      const folder = await tree.createFolder({
        actorId: ownerId,
        parentId: root.id,
        name: 'Draft',
        onConflict: 'fail',
      });

      const renamed = await tree.rename({
        nodeId: folder.id,
        name: 'Final',
        onConflict: 'fail',
      });

      expect(renamed.name).toBe('Final');
      expect(renamed.path).toBe(folder.path);
      expect(renamed.depth).toBe(folder.depth);

      const stored = await prisma.node.findUniqueOrThrow({ where: { id: folder.id } });
      expect(stored.nameCi).toBe('final');
    });

    it('numbers around an existing sibling when asked to keep both', async () => {
      const { root } = await newRoom();
      await tree.createFolder({
        actorId: ownerId,
        parentId: root.id,
        name: 'Reports',
        onConflict: 'fail',
      });
      const other = await tree.createFolder({
        actorId: ownerId,
        parentId: root.id,
        name: 'Scratch',
        onConflict: 'fail',
      });

      const renamed = await tree.rename({
        nodeId: other.id,
        name: 'Reports',
        onConflict: 'rename',
      });
      expect(renamed.name).toBe('Reports (2)');
    });

    it('renames the data room by renaming its root', async () => {
      const { dataRoomId, root } = await newRoom();
      const renamed = await tree.rename({
        nodeId: root.id,
        name: 'Beacon Acquisition',
        onConflict: 'fail',
      });

      expect(renamed.name).toBe('Beacon Acquisition');
      const room = await prisma.dataRoom.findUniqueOrThrow({
        where: { id: dataRoomId },
        include: { rootNode: { select: { name: true } } },
      });
      expect(room.rootNode?.name).toBe('Beacon Acquisition');
    });
  });

  describe('moving', () => {
    it('rewrites the paths of the whole subtree', async () => {
      // Asserted against literal values rather than recomputed with the same helper the
      // code uses: an off-by-one in the substring offset would pass otherwise.
      // Mutation: change `FROM path.length + 1` to + 2 -> these assertions fail.
      const { root } = await newRoom();
      const source = await tree.createFolder({
        actorId: ownerId,
        parentId: root.id,
        name: 'Source',
        onConflict: 'fail',
      });
      const middle = await tree.createFolder({
        actorId: ownerId,
        parentId: source.id,
        name: 'Middle',
        onConflict: 'fail',
      });
      const leaf = await tree.createFolder({
        actorId: ownerId,
        parentId: middle.id,
        name: 'Leaf',
        onConflict: 'fail',
      });
      const destination = await tree.createFolder({
        actorId: ownerId,
        parentId: root.id,
        name: 'Destination',
        onConflict: 'fail',
      });

      await tree.move({
        nodeId: source.id,
        targetParentId: destination.id,
        onConflict: 'fail',
      });

      const [movedSource, movedMiddle, movedLeaf] = await Promise.all([
        prisma.node.findUniqueOrThrow({ where: { id: source.id } }),
        prisma.node.findUniqueOrThrow({ where: { id: middle.id } }),
        prisma.node.findUniqueOrThrow({ where: { id: leaf.id } }),
      ]);

      expect(movedSource.path).toBe(`${destination.path}${source.id}/`);
      expect(movedMiddle.path).toBe(`${destination.path}${source.id}/${middle.id}/`);
      expect(movedLeaf.path).toBe(
        `${destination.path}${source.id}/${middle.id}/${leaf.id}/`,
      );
      expect([movedSource.depth, movedMiddle.depth, movedLeaf.depth]).toEqual([2, 3, 4]);
    });

    it('refuses to move a folder into its own descendant or into itself', async () => {
      // Mutation: remove the isInSubtree check -> the subtree detaches from every listing
      // while its rows remain in place.
      const { root } = await newRoom();
      const parent = await tree.createFolder({
        actorId: ownerId,
        parentId: root.id,
        name: 'Parent',
        onConflict: 'fail',
      });
      const child = await tree.createFolder({
        actorId: ownerId,
        parentId: parent.id,
        name: 'Child',
        onConflict: 'fail',
      });

      await expect(
        tree.move({ nodeId: parent.id, targetParentId: child.id, onConflict: 'fail' }),
      ).rejects.toMatchObject({ code: 'INVALID_MOVE_TARGET' });

      await expect(
        tree.move({ nodeId: parent.id, targetParentId: parent.id, onConflict: 'fail' }),
      ).rejects.toMatchObject({ code: 'INVALID_MOVE_TARGET' });
    });

    it('refuses to move between data rooms', async () => {
      const roomA = await newRoom('Room A');
      const roomB = await newRoom('Room B');
      const folder = await tree.createFolder({
        actorId: ownerId,
        parentId: roomA.root.id,
        name: 'Folder',
        onConflict: 'fail',
      });

      await expect(
        tree.move({ nodeId: folder.id, targetParentId: roomB.root.id, onConflict: 'fail' }),
      ).rejects.toMatchObject({ code: 'INVALID_MOVE_TARGET' });
    });

    it('applies the depth limit to the deepest descendant, not the moved node', async () => {
      // A shallow folder with deep contents must not be droppable near the limit.
      const { root } = await newRoom();
      const shallow = await tree.createFolder({
        actorId: ownerId,
        parentId: root.id,
        name: 'Shallow',
        onConflict: 'fail',
      });
      let parentId = shallow.id;
      for (let level = 0; level < 5; level += 1) {
        parentId = (
          await tree.createFolder({
            actorId: ownerId,
            parentId,
            name: `deep-${level}`,
            onConflict: 'fail',
          })
        ).id;
      }

      // Build a chain to depth 30 to move 'Shallow' (whose subtree is 6 levels tall) into.
      let chainId = root.id;
      for (let level = 1; level <= 30; level += 1) {
        chainId = (
          await tree.createFolder({
            actorId: ownerId,
            parentId: chainId,
            name: `chain-${level}`,
            onConflict: 'fail',
          })
        ).id;
      }

      await expect(
        tree.move({ nodeId: shallow.id, targetParentId: chainId, onConflict: 'fail' }),
      ).rejects.toMatchObject({ code: 'DEPTH_LIMIT_EXCEEDED' });
    });

    it('resolves a name collision in the destination', async () => {
      const { root } = await newRoom();
      const destination = await tree.createFolder({
        actorId: ownerId,
        parentId: root.id,
        name: 'Destination',
        onConflict: 'fail',
      });
      await tree.createFolder({
        actorId: ownerId,
        parentId: destination.id,
        name: 'Notes',
        onConflict: 'fail',
      });
      const moving = await tree.createFolder({
        actorId: ownerId,
        parentId: root.id,
        name: 'Notes',
        onConflict: 'fail',
      });

      const moved = await tree.move({
        nodeId: moving.id,
        targetParentId: destination.id,
        onConflict: 'rename',
      });
      expect(moved.name).toBe('Notes (2)');

      await expect(
        tree.move({ nodeId: moved.id, targetParentId: destination.id, onConflict: 'fail' }),
      ).resolves.toMatchObject({ id: moved.id }); // already there: a no-op, not a conflict
    });
  });

  describe('deleting', () => {
    it('queues every version of every file in the subtree, then removes the rows', async () => {
      // Mutation: filter the key query to current versions only -> the previous version's
      // bytes stay in the bucket, undiscoverable, after the user deleted the document.
      const { root } = await newRoom();
      const folder = await tree.createFolder({
        actorId: ownerId,
        parentId: root.id,
        name: 'Financials',
        onConflict: 'fail',
      });
      const file = await prisma.node.create({
        data: {
          dataRoomId: folder.dataRoomId,
          parentId: folder.id,
          type: 'FILE',
          name: 'accounts.pdf',
          path: `${folder.path}00000000-0000-0000-0000-0000000000ff/`,
          depth: folder.depth + 1,
          createdById: ownerId,
        },
      });
      await prisma.fileVersion.createMany({
        data: [
          {
            nodeId: file.id,
            versionNumber: 1,
            isCurrent: false,
            sizeBytes: 10n,
            mimeType: 'application/pdf',
            storageKey: 'old-version-key',
            createdById: ownerId,
          },
          {
            nodeId: file.id,
            versionNumber: 2,
            isCurrent: true,
            sizeBytes: 20n,
            mimeType: 'application/pdf',
            storageKey: 'current-version-key',
            createdById: ownerId,
          },
        ],
      });

      const result = await tree.deleteSubtree(folder.id);

      expect(result.deletedNodes).toBe(2); // the folder and the file
      const queued = await prisma.pendingBlobDeletion.findMany({ select: { storageKey: true } });
      expect(queued.map((row) => row.storageKey).sort()).toEqual([
        'current-version-key',
        'old-version-key',
      ]);
      expect(await prisma.node.count({ where: { id: file.id } })).toBe(0);
    });
  });

  describe('subtree totals', () => {
    it('counts descendants and sums current versions only', async () => {
      const { root } = await newRoom();
      const folder = await tree.createFolder({
        actorId: ownerId,
        parentId: root.id,
        name: 'Financials',
        onConflict: 'fail',
      });
      const file = await prisma.node.create({
        data: {
          dataRoomId: folder.dataRoomId,
          parentId: folder.id,
          type: 'FILE',
          name: 'accounts.pdf',
          path: `${folder.path}00000000-0000-0000-0000-0000000000aa/`,
          depth: folder.depth + 1,
          createdById: ownerId,
        },
      });
      await prisma.fileVersion.createMany({
        data: [
          {
            nodeId: file.id,
            versionNumber: 1,
            isCurrent: false,
            sizeBytes: 900n,
            mimeType: 'application/pdf',
            storageKey: 'k-old',
            createdById: ownerId,
          },
          {
            nodeId: file.id,
            versionNumber: 2,
            isCurrent: true,
            sizeBytes: 100n,
            mimeType: 'application/pdf',
            storageKey: 'k-new',
            createdById: ownerId,
          },
        ],
      });

      const stats = await tree.stats(root.id);
      // The node itself is excluded, and the superseded 900-byte version is not counted:
      // the number shown next to a folder is its logical size.
      expect(stats).toEqual({ folderCount: 1, fileCount: 1, totalSizeBytes: 100 });
    });

    it('reports zeroes for an empty folder', async () => {
      const { root } = await newRoom();
      expect(await tree.stats(root.id)).toEqual({
        folderCount: 0,
        fileCount: 0,
        totalSizeBytes: 0,
      });
    });
  });

  describe('listing children', () => {
    it('returns folders before files, then by name, and pages without gaps', async () => {
      const { root } = await newRoom();
      for (const name of ['beta', 'Alpha', 'gamma']) {
        await tree.createFolder({
          actorId: ownerId,
          parentId: root.id,
          name,
          onConflict: 'fail',
        });
      }
      for (const [index, name] of ['zeta.pdf', 'Delta.pdf'].entries()) {
        await prisma.node.create({
          data: {
            dataRoomId: root.dataRoomId,
            parentId: root.id,
            type: 'FILE',
            name,
            path: `${root.path}00000000-0000-0000-0000-00000000000${index}/`,
            depth: 1,
            createdById: ownerId,
          },
        });
      }

      const first = await tree.listChildren({ parentId: root.id, limit: 2 });
      const second = await tree.listChildren({
        parentId: root.id,
        limit: 2,
        cursor: first.nextCursor,
      });
      const third = await tree.listChildren({
        parentId: root.id,
        limit: 2,
        cursor: second.nextCursor,
      });

      const names = [...first.items, ...second.items, ...third.items].map((item) => item.name);
      // Case-insensitive ordering comes from name_ci, and folders sort first because the
      // enum is declared FOLDER before FILE.
      expect(names).toEqual(['Alpha', 'beta', 'gamma', 'Delta.pdf', 'zeta.pdf']);
      expect(new Set(names).size).toBe(names.length); // no duplicates across pages
      expect(third.nextCursor).toBeUndefined();
    });

    it('filters to one type when asked', async () => {
      const { root } = await newRoom();
      await tree.createFolder({
        actorId: ownerId,
        parentId: root.id,
        name: 'Folder',
        onConflict: 'fail',
      });
      await prisma.node.create({
        data: {
          dataRoomId: root.dataRoomId,
          parentId: root.id,
          type: 'FILE',
          name: 'file.pdf',
          path: `${root.path}00000000-0000-0000-0000-0000000000bb/`,
          depth: 1,
          createdById: ownerId,
        },
      });

      const files = await tree.listChildren({ parentId: root.id, limit: 10, type: 'FILE' });
      expect(files.items.map((item) => item.name)).toEqual(['file.pdf']);
    });

    it('rejects a malformed cursor instead of silently restarting', async () => {
      const { root } = await newRoom();
      await expect(
        tree.listChildren({ parentId: root.id, limit: 10, cursor: 'not-a-cursor' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('breadcrumbs', () => {
    it('lists ancestors root-first and excludes the node itself', async () => {
      const { root } = await newRoom();
      const middle = await tree.createFolder({
        actorId: ownerId,
        parentId: root.id,
        name: 'Financials',
        onConflict: 'fail',
      });
      const leaf = await tree.createFolder({
        actorId: ownerId,
        parentId: middle.id,
        name: 'Q1',
        onConflict: 'fail',
      });

      expect(await tree.breadcrumbs(leaf)).toEqual([
        { id: root.id, name: 'Acme Acquisition' },
        { id: middle.id, name: 'Financials' },
      ]);
      expect(await tree.breadcrumbs(root)).toEqual([]);
    });
  });
});
