import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';
import { loadAppConfig } from '../src/config/app-config';
import { PrismaClient } from '../src/generated/prisma/client';
import { StorageService } from '../src/storage/storage.service';

/**
 * Removes objects that no row refers to: `pnpm gc:orphans`.
 *
 * Two distinct sources, and conflating them would leave one of them uncollected:
 *
 *  1. **Deleted documents.** Deleting a folder queues every storage key in the same
 *     transaction as the row removal. If the process dies before the objects are deleted,
 *     the keys would otherwise be unrecoverable — the file_versions rows are already gone —
 *     and a document the user deleted would stay in the bucket indefinitely.
 *  2. **Abandoned uploads.** A signed URL that is never completed leaves an object with no
 *     row at all. The upload intent records exactly which key that is.
 *
 * Both work from database rows rather than by listing the bucket, which is why the
 * application's IAM policy does not need `s3:ListBucket` and why the cost of this job does
 * not grow with the amount of stored data.
 */

const BATCH_SIZE = 500;

async function main(): Promise<void> {
  const config = loadAppConfig();
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: config.databaseUrl, max: 2 }),
  });
  const storage = new StorageService(config);

  try {
    const queued = await drainPendingDeletions(prisma, storage);
    const abandoned = await collectAbandonedUploads(prisma, storage);
    console.log(
      `Removed ${queued} object(s) from deleted documents and ${abandoned} from abandoned uploads.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

async function drainPendingDeletions(
  prisma: PrismaClient,
  storage: StorageService,
): Promise<number> {
  let removed = 0;

  for (;;) {
    const batch = await prisma.pendingBlobDeletion.findMany({
      take: BATCH_SIZE,
      orderBy: { createdAt: 'asc' },
    });
    if (batch.length === 0) break;

    const deleted = new Set(await storage.deleteObjects(batch.map((row) => row.storageKey)));

    const succeeded = batch.filter((row) => deleted.has(row.storageKey));
    const failed = batch.filter((row) => !deleted.has(row.storageKey));

    await prisma.pendingBlobDeletion.deleteMany({
      where: { id: { in: succeeded.map((row) => row.id) } },
    });
    // Failures stay queued and are retried on the next run. Dropping them would mean a
    // deleted document quietly remaining in the bucket, which is the one outcome this whole
    // mechanism exists to prevent.
    if (failed.length > 0) {
      await prisma.pendingBlobDeletion.updateMany({
        where: { id: { in: failed.map((row) => row.id) } },
        data: { attempts: { increment: 1 }, lastError: 'delete failed; will retry' },
      });
    }

    removed += succeeded.length;
    if (batch.length < BATCH_SIZE) break;
  }

  return removed;
}

async function collectAbandonedUploads(
  prisma: PrismaClient,
  storage: StorageService,
): Promise<number> {
  let removed = 0;

  for (;;) {
    const expired = await prisma.uploadIntent.findMany({
      where: { consumedAt: null, expiresAt: { lt: new Date() } },
      take: BATCH_SIZE,
      orderBy: { expiresAt: 'asc' },
    });
    if (expired.length === 0) break;

    // Objects first, rows second: a row that outlives its object costs one wasted delete
    // next run, while a row removed before its object leaves the object unfindable.
    await storage.deleteObjects(expired.map((intent) => intent.storageKey));
    await prisma.uploadIntent.deleteMany({ where: { id: { in: expired.map((i) => i.id) } } });

    removed += expired.length;
    if (expired.length < BATCH_SIZE) break;
  }

  return removed;
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
