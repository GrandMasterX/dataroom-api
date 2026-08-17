import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client';

/**
 * Shared harness for integration tests.
 *
 * Points at TEST_DATABASE_URL, never at the development database: these tests truncate
 * between cases and would otherwise wipe the seed on every run.
 */

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is required to run integration tests');
}
if (connectionString === process.env.DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL must differ from DATABASE_URL — these tests truncate tables');
}

export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString, max: 4 }),
});

export const TABLES = [
  'users',
  'data_rooms',
  'nodes',
  'file_versions',
  'share_links',
  'share_grants',
  'upload_intents',
  'refresh_tokens',
  'pending_blob_deletions',
] as const;

export async function truncateAll(): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});
