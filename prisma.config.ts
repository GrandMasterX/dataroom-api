import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

/**
 * Prisma 7 requires this file for every CLI operation: several commands no longer
 * accept `--schema` / `--url` flags.
 *
 * DDL runs over DIRECT_URL rather than DATABASE_URL. In production the application
 * connects through Neon's pooler, and migrations must not run over a pooled
 * connection. Locally both strings are the same.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: env('DIRECT_URL'),
  },
});
