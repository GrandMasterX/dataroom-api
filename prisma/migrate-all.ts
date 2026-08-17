import 'dotenv/config';

import { execFileSync } from 'node:child_process';

/**
 * Applies migrations to both databases: the one the application uses and the one integration
 * tests truncate between cases.
 *
 * This exists as a script rather than as a shell one-liner because the connection strings
 * live in `.env`, which the shell does not read — a `DIRECT_URL=$TEST_DATABASE_URL` prefix
 * expands to an empty value, Prisma quietly falls back to the development database, and the
 * test database is never migrated. The symptom is every integration test failing on a fresh
 * clone, which points at everything except the real cause.
 */
function deploy(label: string, directUrl: string): void {
  console.log(`\nApplying migrations to ${label}…`);
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    stdio: 'inherit',
    env: { ...process.env, DIRECT_URL: directUrl },
  });
}

const appUrl = process.env.DIRECT_URL;
const testUrl = process.env.TEST_DATABASE_URL;

if (!appUrl) throw new Error('DIRECT_URL is required');
if (!testUrl) throw new Error('TEST_DATABASE_URL is required');
if (appUrl === testUrl) {
  // The suites truncate tables; pointed at the development database they would destroy the
  // seed on every run.
  throw new Error('TEST_DATABASE_URL must differ from DIRECT_URL');
}

deploy('the application database', appUrl);
deploy('the test database', testUrl);

execFileSync('pnpm', ['exec', 'prisma', 'generate'], { stdio: 'inherit' });
