import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './app.harness';
import { prisma } from './setup';

/**
 * Sharing, from both sides.
 *
 * The leak cases carry the most weight. Truncating breadcrumbs is the obvious half; the half
 * that actually leaked in review was everything else — a node's own parentId, a search
 * result's path, version history naming employees. So these assertions are made against the
 * response bodies of every endpoint a guest can reach, not against the resolver.
 */
describe('sharing', () => {
  let app: INestApplication;
  let accountCounter = 0;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app?.close();
  });

  const http = () => request(app.getHttpServer());

  async function signUp(label: string): Promise<{ token: string; email: string }> {
    accountCounter += 1;
    const email = `${label}-${accountCounter}@example.com`;
    const response = await http()
      .post('/auth/register')
      .send({ email, password: 'a-long-enough-password', displayName: label })
      .expect(201);
    return { token: response.body.accessToken as string, email };
  }

  /**
   * Acme Acquisition
   *  ├── 03 Legal          <- shared
   *  │    └── NDAs
   *  └── 02 Financials     <- never shared
   */
  async function buildRoom(ownerToken: string) {
    const auth = { Authorization: `Bearer ${ownerToken}` };
    const room = await http()
      .post('/data-rooms')
      .set(auth)
      .send({ name: 'Acme Acquisition' })
      .expect(201);

    const legal = await http()
      .post('/nodes/folders')
      .set(auth)
      .send({ parentId: room.body.rootNodeId, name: '03 Legal' })
      .expect(201);
    const ndas = await http()
      .post('/nodes/folders')
      .set(auth)
      .send({ parentId: legal.body.id, name: 'NDAs' })
      .expect(201);
    const financials = await http()
      .post('/nodes/folders')
      .set(auth)
      .send({ parentId: room.body.rootNodeId, name: '02 Financials' })
      .expect(201);

    return {
      roomId: room.body.id as string,
      rootNodeId: room.body.rootNodeId as string,
      legalId: legal.body.id as string,
      ndasId: ndas.body.id as string,
      financialsId: financials.body.id as string,
    };
  }

  describe('public links', () => {
    it('lets a link holder browse the shared subtree and nothing else', async () => {
      const owner = await signUp('owner');
      const tree = await buildRoom(owner.token);

      const link = await http()
        .post(`/nodes/${tree.legalId}/shares/link`)
        .set({ Authorization: `Bearer ${owner.token}` })
        .send({})
        .expect(200);
      const guest = { 'X-Share-Token': link.body.token as string };

      // What the link points at, before opening anything.
      const context = await http().get(`/shared/${link.body.token}`).expect(200);
      expect(context.body).toEqual({
        nodeId: tree.legalId,
        nodeName: '03 Legal',
        nodeType: 'FOLDER',
      });
      // The data room's name sits above the shared node and must not appear.
      expect(JSON.stringify(context.body)).not.toContain('Acme');

      await http().get(`/nodes/${tree.legalId}`).set(guest).expect(200);
      // Nested content comes with the share, without a second grant.
      await http().get(`/nodes/${tree.ndasId}`).set(guest).expect(200);

      // A sibling that was never shared is not merely forbidden — it is unknowable.
      const sibling = await http().get(`/nodes/${tree.financialsId}`).set(guest).expect(404);
      expect(sibling.body.error.code).toBe('NOT_FOUND');
      await http().get(`/nodes/${tree.rootNodeId}`).set(guest).expect(404);
    });

    it('never names anything above the shared item, on any endpoint', async () => {
      // Mutation: skip projectNode or projectBreadcrumbs in the nodes controller -> this
      // fails on parentId or on the breadcrumb trail respectively.
      const owner = await signUp('owner');
      const tree = await buildRoom(owner.token);

      const link = await http()
        .post(`/nodes/${tree.legalId}/shares/link`)
        .set({ Authorization: `Bearer ${owner.token}` })
        .send({})
        .expect(200);
      const guest = { 'X-Share-Token': link.body.token as string };

      const forbiddenStrings = ['Acme Acquisition', '02 Financials', tree.rootNodeId, tree.financialsId];

      const responses = await Promise.all([
        http().get(`/nodes/${tree.legalId}`).set(guest).expect(200),
        http().get(`/nodes/${tree.legalId}/children`).set(guest).expect(200),
        http().get(`/nodes/${tree.legalId}/stats`).set(guest).expect(200),
        http().get(`/nodes/${tree.ndasId}`).set(guest).expect(200),
        http().get(`/nodes/${tree.ndasId}/children`).set(guest).expect(200),
        http().get(`/shared/${link.body.token}`).expect(200),
      ]);

      for (const response of responses) {
        const body = JSON.stringify(response.body);
        for (const forbidden of forbiddenStrings) {
          expect(body).not.toContain(forbidden);
        }
      }

      // At the boundary the parent exists but is not named, and the trail starts there.
      const shareRoot = responses[0].body;
      expect(shareRoot.node.parentId).toBeNull();
      expect(shareRoot.breadcrumbs).toEqual([]);

      // One level down, the trail starts at the shared folder rather than at the room.
      const nested = responses[3].body;
      expect(nested.breadcrumbs).toEqual([{ id: tree.legalId, name: '03 Legal' }]);
      expect(nested.node.parentId).toBe(tree.legalId);
    });

    it('offers a link holder no way to change anything', async () => {
      const owner = await signUp('owner');
      const tree = await buildRoom(owner.token);
      const link = await http()
        .post(`/nodes/${tree.legalId}/shares/link`)
        .set({ Authorization: `Bearer ${owner.token}` })
        .send({})
        .expect(200);
      const guest = { 'X-Share-Token': link.body.token as string };

      const detail = await http().get(`/nodes/${tree.legalId}`).set(guest).expect(200);
      // The interface renders from these, so a guest is never shown a control that 403s.
      expect(detail.body.capabilities).toMatchObject({
        canCreate: false,
        canRename: false,
        canDelete: false,
        canUpload: false,
        canShare: false,
        canViewVersionHistory: false,
      });

      await http()
        .post('/nodes/folders')
        .set(guest)
        .send({ parentId: tree.legalId, name: 'Intruder' })
        .expect(401);
      await http().delete(`/nodes/${tree.ndasId}`).set(guest).expect(401);
    });

    it('stops working the moment the link is revoked', async () => {
      // Access is re-resolved on every request and never cached in a session; a revoke that
      // only takes effect at the next sign-in is a failed requirement, not a delay.
      const owner = await signUp('owner');
      const tree = await buildRoom(owner.token);
      const link = await http()
        .post(`/nodes/${tree.legalId}/shares/link`)
        .set({ Authorization: `Bearer ${owner.token}` })
        .send({})
        .expect(200);
      const guest = { 'X-Share-Token': link.body.token as string };

      await http().get(`/nodes/${tree.legalId}`).set(guest).expect(200);

      await http()
        .delete(`/shares/links/${link.body.id}`)
        .set({ Authorization: `Bearer ${owner.token}` })
        .expect(204);

      await http().get(`/nodes/${tree.legalId}`).set(guest).expect(404);
      // An unknown, revoked and expired token are one answer: distinguishing them would
      // confirm that a link once existed.
      await http().get(`/shared/${link.body.token}`).expect(404);
    });

    it('ignores an expired link', async () => {
      const owner = await signUp('owner');
      const tree = await buildRoom(owner.token);
      const link = await http()
        .post(`/nodes/${tree.legalId}/shares/link`)
        .set({ Authorization: `Bearer ${owner.token}` })
        .send({ expiresAt: new Date(Date.now() + 60_000).toISOString() })
        .expect(200);
      const guest = { 'X-Share-Token': link.body.token as string };

      await http().get(`/nodes/${tree.legalId}`).set(guest).expect(200);

      await prisma.shareLink.update({
        where: { id: link.body.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await http().get(`/nodes/${tree.legalId}`).set(guest).expect(404);
    });

    it('returns the same link when sharing the same item twice', async () => {
      const owner = await signUp('owner');
      const tree = await buildRoom(owner.token);
      const auth = { Authorization: `Bearer ${owner.token}` };

      const first = await http().post(`/nodes/${tree.legalId}/shares/link`).set(auth).send({}).expect(200);
      const second = await http().post(`/nodes/${tree.legalId}/shares/link`).set(auth).send({}).expect(200);

      expect(second.body.token).toBe(first.body.token);
      expect(await prisma.shareLink.count({ where: { nodeId: tree.legalId } })).toBe(1);
    });
  });

  describe('per-person grants', () => {
    it('grants access by address, including to someone who registers afterwards', async () => {
      const owner = await signUp('owner');
      const tree = await buildRoom(owner.token);
      const invitedEmail = `counsel-${Date.now()}@beacon.com`;

      const grant = await http()
        .post(`/nodes/${tree.legalId}/shares/grants`)
        .set({ Authorization: `Bearer ${owner.token}` })
        .send({ email: invitedEmail.toUpperCase() })
        .expect(200);
      expect(grant.body.email).toBe(invitedEmail.toLowerCase());

      // The account is created only now — access is resolved by address at request time, so
      // there is no "link the grant to a user" step that could be missed.
      const invitee = await http()
        .post('/auth/register')
        .send({ email: invitedEmail, password: 'a-long-enough-password', displayName: 'Counsel' })
        .expect(201);
      const guest = { Authorization: `Bearer ${invitee.body.accessToken}` };

      const shared = await http().get('/shared-with-me').set(guest).expect(200);
      expect(shared.body).toHaveLength(1);
      expect(shared.body[0]).toMatchObject({ nodeId: tree.legalId, nodeName: '03 Legal' });

      await http().get(`/nodes/${tree.legalId}`).set(guest).expect(200);
      // Nested content is included; a sibling is not.
      await http().get(`/nodes/${tree.ndasId}`).set(guest).expect(200);
      await http().get(`/nodes/${tree.financialsId}`).set(guest).expect(404);
    });

    it('reinstates a revoked person instead of stacking grants', async () => {
      const owner = await signUp('owner');
      const invitee = await signUp('counsel');
      const tree = await buildRoom(owner.token);
      const ownerAuth = { Authorization: `Bearer ${owner.token}` };

      const first = await http()
        .post(`/nodes/${tree.legalId}/shares/grants`)
        .set(ownerAuth)
        .send({ email: invitee.email })
        .expect(200);

      await http().delete(`/shares/grants/${first.body.id}`).set(ownerAuth).expect(204);
      await http()
        .get(`/nodes/${tree.legalId}`)
        .set({ Authorization: `Bearer ${invitee.token}` })
        .expect(404);

      const again = await http()
        .post(`/nodes/${tree.legalId}/shares/grants`)
        .set(ownerAuth)
        .send({ email: invitee.email })
        .expect(200);

      expect(again.body.id).toBe(first.body.id);
      expect(await prisma.shareGrant.count({ where: { nodeId: tree.legalId } })).toBe(1);
      await http()
        .get(`/nodes/${tree.legalId}`)
        .set({ Authorization: `Bearer ${invitee.token}` })
        .expect(200);
    });

    it('keeps version history away from guests', async () => {
      // The history names the employees who uploaded each version — internal information
      // about the seller's team, not something a counterparty needs.
      const owner = await signUp('owner');
      const invitee = await signUp('counsel');
      const tree = await buildRoom(owner.token);

      await http()
        .post(`/nodes/${tree.legalId}/shares/grants`)
        .set({ Authorization: `Bearer ${owner.token}` })
        .send({ email: invitee.email })
        .expect(200);

      const file = await prisma.node.create({
        data: {
          dataRoomId: (await prisma.node.findUniqueOrThrow({ where: { id: tree.legalId } })).dataRoomId,
          parentId: tree.legalId,
          type: 'FILE',
          name: 'nda.pdf',
          path: `${(await prisma.node.findUniqueOrThrow({ where: { id: tree.legalId } })).path}00000000-0000-0000-0000-0000000000dd/`,
          depth: 2,
          createdById: (await prisma.user.findFirstOrThrow({ where: { email: owner.email } })).id,
        },
      });

      const guest = { Authorization: `Bearer ${invitee.token}` };
      await http().get(`/nodes/${file.id}`).set(guest).expect(200);

      const denied = await http().get(`/files/${file.id}/versions`).set(guest).expect(403);
      expect(denied.body.error.code).toBe('FORBIDDEN');
    });

    it('resolves an invitation link only for the invited address', async () => {
      const owner = await signUp('owner');
      const invitee = await signUp('counsel');
      const stranger = await signUp('stranger');
      const tree = await buildRoom(owner.token);

      const grant = await http()
        .post(`/nodes/${tree.legalId}/shares/grants`)
        .set({ Authorization: `Bearer ${owner.token}` })
        .send({ email: invitee.email })
        .expect(200);

      await http()
        .get(`/invites/${grant.body.id}`)
        .set({ Authorization: `Bearer ${invitee.token}` })
        .expect(200)
        .expect((res) => expect(res.body.nodeName).toBe('03 Legal'));

      // Holding the id is not enough: it would otherwise disclose what was shared and with whom.
      await http()
        .get(`/invites/${grant.body.id}`)
        .set({ Authorization: `Bearer ${stranger.token}` })
        .expect(404);
    });
  });

  describe('search', () => {
    it('is confined to the shared subtree', async () => {
      // Search is addressed by node, so the boundary is the item the caller may see. A guest
      // cannot widen it by changing a parameter, and there is no separate guest rule to keep
      // in step with the owner's.
      // Mutation: scope the query by data room instead of by node path -> the second
      // assertion finds the file and this fails.
      const owner = await signUp('owner');
      const tree = await buildRoom(owner.token);
      const ownerAuth = { Authorization: `Bearer ${owner.token}` };

      await http()
        .post('/nodes/folders')
        .set(ownerAuth)
        .send({ parentId: tree.ndasId, name: 'Beacon NDA drafts' })
        .expect(201);
      await http()
        .post('/nodes/folders')
        .set(ownerAuth)
        .send({ parentId: tree.financialsId, name: 'Beacon revenue model' })
        .expect(201);

      const link = await http()
        .post(`/nodes/${tree.legalId}/shares/link`)
        .set(ownerAuth)
        .send({})
        .expect(200);
      const guest = { 'X-Share-Token': link.body.token as string };

      const owned = await http()
        .get(`/nodes/${tree.rootNodeId}/search?q=beacon`)
        .set(ownerAuth)
        .expect(200);
      expect(owned.body.map((hit: { name: string }) => hit.name).sort()).toEqual([
        'Beacon NDA drafts',
        'Beacon revenue model',
      ]);

      const shared = await http()
        .get(`/nodes/${tree.legalId}/search?q=beacon`)
        .set(guest)
        .expect(200);
      expect(shared.body).toHaveLength(1);
      expect(shared.body[0].name).toBe('Beacon NDA drafts');
      // Nothing from outside the share leaks through the result's context either.
      expect(JSON.stringify(shared.body)).not.toContain('02 Financials');
    });

    it('refuses a query too short to use the index', async () => {
      const owner = await signUp('owner');
      const tree = await buildRoom(owner.token);

      const response = await http()
        .get(`/nodes/${tree.rootNodeId}/search?q=be`)
        .set({ Authorization: `Bearer ${owner.token}` })
        .expect(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('overlapping access', () => {
    it('treats a signed-in visitor holding someone else’s link as a guest there', async () => {
      // Both a session and a token can be present at once; treating them as alternatives
      // would resolve this request as the wrong identity.
      const owner = await signUp('owner');
      const visitor = await signUp('visitor');
      const tree = await buildRoom(owner.token);

      const link = await http()
        .post(`/nodes/${tree.legalId}/shares/link`)
        .set({ Authorization: `Bearer ${owner.token}` })
        .send({})
        .expect(200);

      const both = {
        Authorization: `Bearer ${visitor.token}`,
        'X-Share-Token': link.body.token as string,
      };

      const detail = await http().get(`/nodes/${tree.legalId}`).set(both).expect(200);
      expect(detail.body.capabilities.canUpload).toBe(false);

      // Their own room is unaffected by carrying someone else's token.
      const ownRoom = await http()
        .post('/data-rooms')
        .set({ Authorization: `Bearer ${visitor.token}` })
        .send({ name: 'Visitor Room' })
        .expect(201);
      const ownDetail = await http().get(`/nodes/${ownRoom.body.rootNodeId}`).set(both).expect(200);
      expect(ownDetail.body.capabilities.canUpload).toBe(true);
    });

    it('gives the most permissive role when several grants apply', async () => {
      const owner = await signUp('owner');
      const invitee = await signUp('counsel');
      const tree = await buildRoom(owner.token);
      const ownerAuth = { Authorization: `Bearer ${owner.token}` };

      // Nested grants: one on the folder, one on its child.
      await http().post(`/nodes/${tree.legalId}/shares/grants`).set(ownerAuth).send({ email: invitee.email }).expect(200);
      await http().post(`/nodes/${tree.ndasId}/shares/grants`).set(ownerAuth).send({ email: invitee.email }).expect(200);

      const guest = { Authorization: `Bearer ${invitee.token}` };
      // The deepest applicable share defines the visible boundary, so the trail is empty at
      // the child rather than showing the folder above it.
      const nested = await http().get(`/nodes/${tree.ndasId}`).set(guest).expect(200);
      expect(nested.body.breadcrumbs).toEqual([]);
      expect(nested.body.node.parentId).toBeNull();

      // And the folder itself is still reachable through the other grant.
      await http().get(`/nodes/${tree.legalId}`).set(guest).expect(200);
    });
  });
});
