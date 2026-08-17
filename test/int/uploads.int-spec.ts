import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './app.harness';
import { prisma } from './setup';

/**
 * The upload path end to end, against a real object store.
 *
 * Signature composition and disposition handling are properties of S3, not of this code, so
 * a mocked client could only confirm what the author already believed. MinIO enforces the
 * same signing rules, which is what makes these tests worth running.
 *
 * What this suite cannot catch: real S3 CORS. MinIO permits every origin, so a missing CORS
 * rule on the production bucket would pass here and fail in a browser. That is verified once,
 * manually, from the deployed frontend.
 */
describe('uploads', () => {
  let app: INestApplication;
  let token: string;
  let rootNodeId: string;
  let accountCounter = 0;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app?.close();
  });

  const http = () => request(app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${token}` });

  beforeEach(async () => {
    accountCounter += 1;
    const session = await http()
      .post('/auth/register')
      .send({
        email: `uploader-${accountCounter}@example.com`,
        password: 'a-long-enough-password',
        displayName: 'Uploader',
      })
      .expect(201);
    token = session.body.accessToken;

    const room = await http()
      .post('/data-rooms')
      .set(auth())
      .send({ name: 'Acme Acquisition' })
      .expect(201);
    rootNodeId = room.body.rootNodeId;
  });

  const PDF_BYTES = Buffer.from('%PDF-1.7\n% test document\n');

  async function presignOne(fileName: string, sizeBytes = PDF_BYTES.byteLength) {
    const response = await http()
      .post('/uploads/presign')
      .set(auth())
      .send({
        parentId: rootNodeId,
        items: [{ fileName, mimeType: 'application/pdf', sizeBytes }],
      })
      .expect(200);
    return response.body.items[0] as {
      intentId: string;
      uploadUrl: string;
      contentType: string;
      conflict?: { existingNodeId: string; existingType: string; versionCount: number };
    };
  }

  async function putObject(
    url: string,
    body: Buffer,
    contentType: string,
  ): Promise<Response> {
    return fetch(url, { method: 'PUT', body: new Uint8Array(body), headers: { 'Content-Type': contentType } });
  }

  it('signs, uploads and registers a file', async () => {
    const item = await presignOne('Q1 Accounts.pdf');
    const put = await putObject(item.uploadUrl, PDF_BYTES, item.contentType);
    expect(put.status).toBe(200);

    const completed = await http()
      .post('/uploads/complete')
      .set(auth())
      .send({ intentId: item.intentId })
      .expect(200);

    expect(completed.body.node.name).toBe('Q1 Accounts.pdf');
    expect(completed.body.versionNumber).toBe(1);
    // The size recorded is the one the store reports, not the one the client declared.
    expect(completed.body.sizeBytes).toBe(PDF_BYTES.byteLength);

    const listing = await http()
      .get(`/nodes/${rootNodeId}/children`)
      .set(auth())
      .expect(200);
    expect(listing.body.items).toHaveLength(1);
    expect(listing.body.items[0]).toMatchObject({
      name: 'Q1 Accounts.pdf',
      type: 'FILE',
      sizeBytes: PDF_BYTES.byteLength,
    });
  });

  it('refuses a PUT whose Content-Type differs from the signed one', async () => {
    // The rule that decides whether uploads work at all: the content type is part of the
    // signature, so the client must echo back exactly what presign returned rather than
    // deriving it again.
    // Mutation: drop ContentType from the PutObjectCommand in presignUpload -> the mismatch
    // stops being rejected and this fails.
    const item = await presignOne('mismatch.pdf');
    const put = await putObject(item.uploadUrl, PDF_BYTES, 'application/octet-stream');
    expect(put.status).toBe(403);

    // Nothing landed, so completion has nothing to register.
    const response = await http()
      .post('/uploads/complete')
      .set(auth())
      .send({ intentId: item.intentId })
      .expect(422);
    expect(response.body.error.code).toBe('UPLOAD_NOT_FINISHED');
  });

  it('rejects an object whose size does not match what was declared', async () => {
    // The signature cannot enforce size — ContentLength is deliberately unsigned — so a
    // client can declare one number and send another. That is caught here, and the orphaned
    // object is queued for deletion because nothing will ever reference it.
    const item = await presignOne('understated.pdf', PDF_BYTES.byteLength);
    const biggerBody = Buffer.concat([PDF_BYTES, Buffer.alloc(500, 0x20)]);
    expect((await putObject(item.uploadUrl, biggerBody, item.contentType)).status).toBe(200);

    const response = await http()
      .post('/uploads/complete')
      .set(auth())
      .send({ intentId: item.intentId })
      .expect(422);
    expect(response.body.error.code).toBe('UPLOAD_NOT_FINISHED');

    const queued = await prisma.pendingBlobDeletion.count();
    expect(queued).toBe(1);
    expect(await prisma.node.count({ where: { type: 'FILE' } })).toBe(0);
  });

  it('returns the same result when completion is retried', async () => {
    // A dropped response must not turn a successful upload into a conflict.
    // Mutation: remove the consumedAt short-circuit -> the retry reports NAME_CONFLICT.
    const item = await presignOne('retried.pdf');
    await putObject(item.uploadUrl, PDF_BYTES, item.contentType);

    const first = await http()
      .post('/uploads/complete')
      .set(auth())
      .send({ intentId: item.intentId })
      .expect(200);
    const second = await http()
      .post('/uploads/complete')
      .set(auth())
      .send({ intentId: item.intentId })
      .expect(200);

    expect(second.body).toEqual(first.body);
    expect(await prisma.fileVersion.count()).toBe(1);
    expect(await prisma.node.count({ where: { type: 'FILE' } })).toBe(1);
  });

  describe('name collisions', () => {
    async function uploadFile(fileName: string, onConflict?: string) {
      const item = await presignOne(fileName);
      await putObject(item.uploadUrl, PDF_BYTES, item.contentType);
      return { item, complete: () =>
        http().post('/uploads/complete').set(auth()).send({ intentId: item.intentId, onConflict }) };
    }

    it('reports the collision before the bytes are sent, with what the UI needs', async () => {
      await (await uploadFile('contract.pdf')).complete().expect(200);

      const second = await presignOne('CONTRACT.PDF');
      expect(second.conflict).toMatchObject({ existingType: 'FILE', versionCount: 1 });
    });

    it('keeps both files when asked, and does not consume the upload on refusal', async () => {
      await (await uploadFile('contract.pdf')).complete().expect(200);

      const item = await presignOne('contract.pdf');
      await putObject(item.uploadUrl, PDF_BYTES, item.contentType);

      const refused = await http()
        .post('/uploads/complete')
        .set(auth())
        .send({ intentId: item.intentId, onConflict: 'fail' })
        .expect(409);
      expect(refused.body.error.code).toBe('NAME_CONFLICT');

      // The bytes are still there: answering differently must not require another upload.
      const kept = await http()
        .post('/uploads/complete')
        .set(auth())
        .send({ intentId: item.intentId, onConflict: 'rename' })
        .expect(200);
      expect(kept.body.node.name).toBe('contract (2).pdf');
    });

    it('adds a version to the existing file when asked', async () => {
      const first = await uploadFile('contract.pdf');
      const original = await first.complete().expect(200);

      const item = await presignOne('contract.pdf');
      await putObject(item.uploadUrl, Buffer.concat([PDF_BYTES, Buffer.from('v2')]), item.contentType);
      // The declared size no longer matches, so this upload declares its own size.
      await prisma.uploadIntent.update({
        where: { id: item.intentId },
        data: { declaredSize: BigInt(PDF_BYTES.byteLength + 2) },
      });

      const versioned = await http()
        .post('/uploads/complete')
        .set(auth())
        .send({ intentId: item.intentId, onConflict: 'newVersion' })
        .expect(200);

      expect(versioned.body.node.id).toBe(original.body.node.id);
      expect(versioned.body.versionNumber).toBe(2);

      const versions = await http()
        .get(`/files/${original.body.node.id}/versions`)
        .set(auth())
        .expect(200);
      expect(versions.body.map((v: { versionNumber: number; isCurrent: boolean }) => [
        v.versionNumber,
        v.isCurrent,
      ])).toEqual([
        [2, true],
        [1, false],
      ]);
    });

    it('refuses to version a file that moved away between signing and completing', async () => {
      // Otherwise the version lands on a document the user is not looking at, and that
      // document's current version silently changes.
      // Mutation: drop the re-check in addVersionToExisting -> this fails.
      const first = await uploadFile('contract.pdf');
      const created = await first.complete().expect(200);

      const item = await presignOne('contract.pdf');
      await putObject(item.uploadUrl, PDF_BYTES, item.contentType);

      await http()
        .patch(`/nodes/${created.body.node.id}`)
        .set(auth())
        .send({ name: 'contract-final.pdf' })
        .expect(200);

      const response = await http()
        .post('/uploads/complete')
        .set(auth())
        .send({ intentId: item.intentId, onConflict: 'newVersion' })
        .expect(409);
      expect(response.body.error.code).toBe('NAME_CONFLICT');
    });
  });

  it('reports the destination being deleted mid-upload as gone, not as a crash', async () => {
    const folder = await http()
      .post('/nodes/folders')
      .set(auth())
      .send({ parentId: rootNodeId, name: 'Financials' })
      .expect(201);

    const presigned = await http()
      .post('/uploads/presign')
      .set(auth())
      .send({
        parentId: folder.body.id,
        items: [{ fileName: 'accounts.pdf', mimeType: 'application/pdf', sizeBytes: PDF_BYTES.byteLength }],
      })
      .expect(200);
    const item = presigned.body.items[0];
    await putObject(item.uploadUrl, PDF_BYTES, item.contentType);

    await http().delete(`/nodes/${folder.body.id}`).set(auth()).expect(200);

    const response = await http()
      .post('/uploads/complete')
      .set(auth())
      .send({ intentId: item.intentId })
      .expect(410);
    expect(response.body.error.code).toBe('GONE');
  });

  it('rejects unsupported types and oversized declarations up front', async () => {
    const scriptable = await http()
      .post('/uploads/presign')
      .set(auth())
      .send({
        parentId: rootNodeId,
        items: [{ fileName: 'page.html', mimeType: 'text/html', sizeBytes: 10 }],
      })
      .expect(422);
    expect(scriptable.body.error.code).toBe('UNSUPPORTED_MIME');

    const huge = await http()
      .post('/uploads/presign')
      .set(auth())
      .send({
        parentId: rootNodeId,
        items: [{ fileName: 'huge.pdf', mimeType: 'application/pdf', sizeBytes: 999_999_999 }],
      })
      .expect(422);
    expect(huge.body.error.code).toBe('FILE_TOO_LARGE');
  });

  describe('reading a file back', () => {
    it('signs an inline URL for a PDF that carries the file’s current name', async () => {
      const item = await presignOne('Original Name.pdf');
      await putObject(item.uploadUrl, PDF_BYTES, item.contentType);
      const created = await http()
        .post('/uploads/complete')
        .set(auth())
        .send({ intentId: item.intentId })
        .expect(200);

      await http()
        .patch(`/nodes/${created.body.node.id}`)
        .set(auth())
        .send({ name: 'Renamed Ünicode.pdf' })
        .expect(200);

      const preview = await http()
        .get(`/files/${created.body.node.id}/preview-url`)
        .set(auth())
        .expect(200);

      expect(preview.body.disposition).toBe('inline');
      // The name is applied when the URL is signed, so a rename is reflected without
      // touching the stored object.
      expect(preview.body.fileName).toBe('Renamed Ünicode.pdf');
      expect(preview.body.url).toContain('response-content-disposition');

      // The URL actually works and returns the bytes that were uploaded.
      const fetched = await fetch(preview.body.url);
      expect(fetched.status).toBe(200);
      expect(Buffer.from(await fetched.arrayBuffer())).toEqual(PDF_BYTES);

      const disposition = fetched.headers.get('content-disposition') ?? '';
      expect(disposition).toContain('inline');
      // RFC 5987 encoding, without which a non-ASCII name is mangled or dropped.
      expect(disposition).toContain("filename*=UTF-8''");
    });
  });
});
