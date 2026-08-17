import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import * as argon2 from 'argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { loadAppConfig } from '../src/config/app-config';
import { PrismaClient } from '../src/generated/prisma/client';
import { buildChildPath, buildRootPath, depthFromPath } from '../src/nodes/node-path';
import { createS3Client } from '../src/storage/s3-client.factory';
import { buildStorageKey } from '../src/storage/storage-key';

/**
 * Demo data. This is part of the product experience, not a debugging convenience: a
 * reviewer should land on a data room that already looks like one, and should be able to
 * check sharing without registering two accounts by hand.
 *
 * The PDFs are generated rather than committed, so the repository stays free of binaries
 * and the files are guaranteed to open.
 */

const DEMO_PASSWORD = 'Password123!';

// The seed goes through the same validated config and the same client factory as the
// application. Reading process.env directly here would be a second, divergent view of
// the environment — and the S3 credential precedence trap the factory documents is
// exactly the kind of thing that only bites the copy nobody reviewed.
const config = loadAppConfig();

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: config.databaseUrl, max: 2 }),
});

const s3 = createS3Client(config);

async function buildPdf(title: string, lines: string[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([595, 842]);

  page.drawText(title, { x: 56, y: 760, size: 22, font });
  lines.forEach((line, index) => {
    page.drawText(line, { x: 56, y: 710 - index * 22, size: 12, font });
  });

  return pdf.save();
}

interface FolderRef {
  id: string;
  path: string;
}

async function main(): Promise<void> {
  const bucket = config.s3.bucket;

  // Truncate rather than upsert: the seed defines a known starting state, and partial
  // leftovers from a previous shape are harder to reason about than an empty database.
  await prisma.$executeRawUnsafe(`
    TRUNCATE users, data_rooms, nodes, file_versions, share_links, share_grants,
             upload_intents, refresh_tokens, pending_blob_deletions RESTART IDENTITY CASCADE`);

  const passwordHash = await argon2.hash(DEMO_PASSWORD, { type: argon2.argon2id });

  const [owner, viewer] = await Promise.all([
    prisma.user.create({
      data: { email: 'owner@demo.dataroom', passwordHash, displayName: 'Dana Owner' },
    }),
    prisma.user.create({
      data: { email: 'viewer@demo.dataroom', passwordHash, displayName: 'Sam Viewer' },
    }),
  ]);

  // A data room is created as room -> root node -> pointer, in one transaction. The
  // room's name is the root node's name; there is no second column holding it.
  const rootId = randomUUID();
  const room = await prisma.$transaction(async (tx) => {
    const created = await tx.dataRoom.create({ data: { ownerId: owner.id } });
    await tx.node.create({
      data: {
        id: rootId,
        dataRoomId: created.id,
        parentId: null,
        type: 'FOLDER',
        name: 'Acme Acquisition',
        path: buildRootPath(rootId),
        depth: depthFromPath(buildRootPath(rootId)),
        createdById: owner.id,
      },
    });
    return tx.dataRoom.update({ where: { id: created.id }, data: { rootNodeId: rootId } });
  });

  const createFolder = async (parent: FolderRef, name: string): Promise<FolderRef> => {
    const id = randomUUID();
    const path = buildChildPath(parent.path, id);
    await prisma.node.create({
      data: {
        id,
        dataRoomId: room.id,
        parentId: parent.id,
        type: 'FOLDER',
        name,
        path,
        depth: depthFromPath(path),
        createdById: owner.id,
      },
    });
    return { id, path };
  };

  const createFile = async (
    parent: FolderRef,
    name: string,
    bytes: Uint8Array,
  ): Promise<string> => {
    const nodeId = randomUUID();
    // The version's id doubles as the upload id in the real flow, and the storage key is
    // built from it; the seed mirrors that so demo objects look like uploaded ones.
    const versionId = randomUUID();
    const path = buildChildPath(parent.path, nodeId);
    const storageKey = buildStorageKey({ dataRoomId: room.id, uploadIntentId: versionId });

    // Object first, row second. An unreferenced object is cheap and collectable; a row
    // pointing at bytes that were never stored is a broken file in the UI.
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: storageKey,
        Body: bytes,
        ContentType: 'application/pdf',
      }),
    );

    await prisma.$transaction(async (tx) => {
      await tx.node.create({
        data: {
          id: nodeId,
          dataRoomId: room.id,
          parentId: parent.id,
          type: 'FILE',
          name,
          path,
          depth: depthFromPath(path),
          createdById: owner.id,
        },
      });
      await tx.fileVersion.create({
        data: {
          id: versionId,
          nodeId,
          versionNumber: 1,
          isCurrent: true,
          sizeBytes: BigInt(bytes.byteLength),
          mimeType: 'application/pdf',
          storageKey,
          createdById: owner.id,
        },
      });
    });

    return nodeId;
  };

  const root: FolderRef = { id: rootId, path: buildRootPath(rootId) };
  const corporate = await createFolder(root, '01 Corporate');
  const financials = await createFolder(root, '02 Financials');
  const q1 = await createFolder(financials, 'Q1 2026');
  const legal = await createFolder(root, '03 Legal');

  await createFile(
    corporate,
    'Certificate of Incorporation.pdf',
    await buildPdf('Certificate of Incorporation', [
      'Acme Corp., Delaware',
      'Filed 14 March 2019',
      'Registered agent: Northwest Registered Agent LLC',
    ]),
  );
  await createFile(
    q1,
    'Q1 2026 Management Accounts.pdf',
    await buildPdf('Q1 2026 Management Accounts', [
      'Revenue          $ 14,208,331',
      'Gross margin            61.4 %',
      'Operating income  $ 2,118,904',
      'Cash and equivalents $ 31,004,556',
    ]),
  );
  await createFile(
    legal,
    'Mutual NDA (executed).pdf',
    await buildPdf('Mutual Non-Disclosure Agreement', [
      'Between: Acme Corp. and Beacon Holdings LP',
      'Effective: 2 August 2026',
      'Term: three years from the effective date',
    ]),
  );

  // One of each sharing mode, so both flows are visible on first login.
  await prisma.shareLink.create({
    data: {
      nodeId: legal.id,
      dataRoomId: room.id,
      token: randomUUID().replaceAll('-', ''),
      createdById: owner.id,
    },
  });
  await prisma.shareGrant.create({
    data: {
      nodeId: financials.id,
      dataRoomId: room.id,
      inviteeEmail: viewer.email,
      createdById: owner.id,
    },
  });

  const link = await prisma.shareLink.findFirstOrThrow({ where: { nodeId: legal.id } });
  console.log(`
Seed complete.

  Data room   Acme Acquisition
  Owner       owner@demo.dataroom  / ${DEMO_PASSWORD}
  Viewer      viewer@demo.dataroom / ${DEMO_PASSWORD}   (granted read access to "02 Financials")
  Public link /s/${link.token}   (shares "03 Legal")
`);
}

void main()
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
