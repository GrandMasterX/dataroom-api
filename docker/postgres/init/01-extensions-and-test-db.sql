-- Local initialisation only. Production has no init scripts, so the same extensions
-- are also created idempotently by the first Prisma migration; here they exist so the
-- integration database is ready before the first `migrate deploy`.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- A separate database for integration tests: they truncate between cases, and doing
-- that in the development database would destroy the seed on every run.
CREATE DATABASE dataroom_test OWNER dataroom;

\connect dataroom_test
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;
