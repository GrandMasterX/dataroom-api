import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './app.harness';
import { prisma } from './setup';

/**
 * The HTTP layer for folders, files and data rooms.
 *
 * The isolation cases matter most: a data room is private until shared, and "private" has
 * to mean an outsider cannot even learn that a document exists.
 */
describe('nodes over HTTP', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app?.close();
  });

  const http = () => request(app.getHttpServer());

  // Unique per call: auth attempts are limited per email address, so reusing one address
  // across a dozen cases would trip a limit that exists for a good reason.
  let accountCounter = 0;
  async function signUp(label: string): Promise<string> {
    accountCounter += 1;
    const email = `${label}-${accountCounter}@example.com`;
    const response = await http()
      .post('/auth/register')
      .send({ email, password: 'a-long-enough-password', displayName: 'Test User' })
      .expect(201);
    return response.body.accessToken as string;
  }

  async function createRoom(token: string, name = 'Acme Acquisition') {
    const response = await http()
      .post('/data-rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({ name })
      .expect(201);
    return response.body as { id: string; rootNodeId: string; name: string };
  }

  describe('data rooms', () => {
    it('creates a room, lists it, and browses from its root', async () => {
      const token = await signUp('owner');
      const room = await createRoom(token);

      const list = await http()
        .get('/data-rooms')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0]).toMatchObject({ id: room.id, name: 'Acme Acquisition' });

      const root = await http()
        .get(`/nodes/${room.rootNodeId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(root.body.node.parentId).toBeNull();
      expect(root.body.breadcrumbs).toEqual([]);
      expect(root.body.capabilities).toMatchObject({ canUpload: true, canShare: true });
    });

    it('renames the room by renaming its root node', async () => {
      const token = await signUp('owner');
      const room = await createRoom(token);

      await http()
        .patch(`/data-rooms/${room.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Project Beacon' })
        .expect(200)
        .expect((res) => expect(res.body.name).toBe('Project Beacon'));

      const node = await http()
        .get(`/nodes/${room.rootNodeId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(node.body.node.name).toBe('Project Beacon');
    });

    it('deletes a room through the same subtree path, queueing its objects', async () => {
      const token = await signUp('owner');
      const room = await createRoom(token);

      const folder = await http()
        .post('/nodes/folders')
        .set('Authorization', `Bearer ${token}`)
        .send({ parentId: room.rootNodeId, name: 'Financials' })
        .expect(201);

      // A file with bytes, so the queue has something to hold.
      const file = await prisma.node.create({
        data: {
          dataRoomId: room.id,
          parentId: folder.body.id,
          type: 'FILE',
          name: 'accounts.pdf',
          path: `${(await prisma.node.findUniqueOrThrow({ where: { id: folder.body.id } })).path}00000000-0000-0000-0000-0000000000cc/`,
          depth: 2,
          createdById: (await prisma.user.findFirstOrThrow()).id,
        },
      });
      await prisma.fileVersion.create({
        data: {
          nodeId: file.id,
          versionNumber: 1,
          isCurrent: true,
          sizeBytes: 42n,
          mimeType: 'application/pdf',
          storageKey: 'room-delete-key',
          createdById: file.createdById,
        },
      });

      await http()
        .delete(`/data-rooms/${room.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
        .expect((res) => expect(res.body.deletedItems).toBe(3));

      expect(await prisma.dataRoom.count()).toBe(0);
      const queued = await prisma.pendingBlobDeletion.findMany({ select: { storageKey: true } });
      expect(queued.map((row) => row.storageKey)).toEqual(['room-delete-key']);
    });
  });

  describe('folders', () => {
    it('reports a name conflict with a code the UI can act on', async () => {
      const token = await signUp('owner');
      const room = await createRoom(token);

      await http()
        .post('/nodes/folders')
        .set('Authorization', `Bearer ${token}`)
        .send({ parentId: room.rootNodeId, name: 'Legal' })
        .expect(201);

      const conflict = await http()
        .post('/nodes/folders')
        .set('Authorization', `Bearer ${token}`)
        .send({ parentId: room.rootNodeId, name: 'legal' })
        .expect(409);
      expect(conflict.body.error.code).toBe('NAME_CONFLICT');

      const kept = await http()
        .post('/nodes/folders')
        .set('Authorization', `Bearer ${token}`)
        .send({ parentId: room.rootNodeId, name: 'Legal', onConflict: 'rename' })
        .expect(201);
      expect(kept.body.name).toBe('Legal (2)');
    });

    it('rejects names that would be unreadable in a listing', async () => {
      const token = await signUp('owner');
      const room = await createRoom(token);

      for (const name of ['with/slash', 'line\nbreak', '   ', '...']) {
        const response = await http()
          .post('/nodes/folders')
          .set('Authorization', `Bearer ${token}`)
          .send({ parentId: room.rootNodeId, name })
          .expect(400);
        expect(response.body.error.code).toBe('VALIDATION_FAILED');
      }
    });

    it('paginates children with a cursor', async () => {
      const token = await signUp('owner');
      const room = await createRoom(token);
      for (const name of ['Alpha', 'Beta', 'Gamma']) {
        await http()
          .post('/nodes/folders')
          .set('Authorization', `Bearer ${token}`)
          .send({ parentId: room.rootNodeId, name })
          .expect(201);
      }

      const first = await http()
        .get(`/nodes/${room.rootNodeId}/children?limit=2`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(first.body.items.map((i: { name: string }) => i.name)).toEqual(['Alpha', 'Beta']);

      const second = await http()
        .get(`/nodes/${room.rootNodeId}/children?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(second.body.items.map((i: { name: string }) => i.name)).toEqual(['Gamma']);
      expect(second.body.nextCursor).toBeUndefined();
    });
  });

  describe('isolation between accounts', () => {
    /**
     * The security-critical assertion in this file. A stranger asking about a node in
     * someone else's room must get 404, never 403: a 403 confirms the node exists, and in a
     * due-diligence product that alone tells an outsider a deal is under way.
     *
     * Mutation: change any of these to ForbiddenException -> the corresponding case fails.
     */
    it('answers 404, not 403, for every read endpoint on a foreign node', async () => {
      const ownerToken = await signUp('owner');
      const strangerToken = await signUp('stranger');
      const room = await createRoom(ownerToken);
      const folder = await http()
        .post('/nodes/folders')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ parentId: room.rootNodeId, name: 'Financials' })
        .expect(201);

      const paths = [
        `/nodes/${folder.body.id}`,
        `/nodes/${folder.body.id}/children`,
        `/nodes/${folder.body.id}/stats`,
        `/data-rooms/${room.id}`,
      ];

      for (const path of paths) {
        const response = await http()
          .get(path)
          .set('Authorization', `Bearer ${strangerToken}`)
          .expect(404);
        expect(response.body.error.code).toBe('NOT_FOUND');
        // Nothing about the room leaks through the message either.
        expect(JSON.stringify(response.body)).not.toContain('Financials');
      }
    });

    it('refuses foreign mutations without revealing the target', async () => {
      const ownerToken = await signUp('owner');
      const strangerToken = await signUp('stranger');
      const room = await createRoom(ownerToken);

      await http()
        .post('/nodes/folders')
        .set('Authorization', `Bearer ${strangerToken}`)
        .send({ parentId: room.rootNodeId, name: 'Intruder' })
        .expect(404);

      await http()
        .patch(`/nodes/${room.rootNodeId}`)
        .set('Authorization', `Bearer ${strangerToken}`)
        .send({ name: 'Renamed by stranger' })
        .expect(404);

      await http()
        .delete(`/nodes/${room.rootNodeId}`)
        .set('Authorization', `Bearer ${strangerToken}`)
        .expect(404);

      expect(await prisma.node.count({ where: { dataRoomId: room.id } })).toBe(1);
    });

    it('requires a session for mutations', async () => {
      const ownerToken = await signUp('owner');
      const room = await createRoom(ownerToken);

      const response = await http()
        .post('/nodes/folders')
        .send({ parentId: room.rootNodeId, name: 'Anonymous' })
        .expect(401);
      expect(response.body.error.code).toBe('UNAUTHENTICATED');
    });
  });

  describe('moving', () => {
    it('checks permission on both ends of the move', async () => {
      // Moving out of a folder you may write into one you may not would otherwise relocate
      // documents into a stranger's room.
      const ownerToken = await signUp('owner');
      const strangerToken = await signUp('stranger');

      const ownRoom = await createRoom(ownerToken, 'Mine');
      const foreignRoom = await createRoom(strangerToken, 'Theirs');

      const folder = await http()
        .post('/nodes/folders')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ parentId: ownRoom.rootNodeId, name: 'Financials' })
        .expect(201);

      await http()
        .post(`/nodes/${folder.body.id}/move`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ targetParentId: foreignRoom.rootNodeId })
        .expect(404);
    });
  });
});
