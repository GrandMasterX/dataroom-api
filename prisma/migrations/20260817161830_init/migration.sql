-- CreateEnum
CREATE TYPE "node_type" AS ENUM ('FOLDER', 'FILE');

-- CreateEnum
CREATE TYPE "share_role" AS ENUM ('VIEWER');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "replaced_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_rooms" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "root_node_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "data_rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nodes" (
    "id" UUID NOT NULL,
    "data_room_id" UUID NOT NULL,
    "parent_id" UUID,
    "type" "node_type" NOT NULL,
    "name" TEXT NOT NULL,
    "name_ci" TEXT NOT NULL DEFAULT '',
    "path" TEXT NOT NULL,
    "depth" INTEGER NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_versions" (
    "id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "size_bytes" BIGINT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "checksum" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "share_links" (
    "id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    "data_room_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "role" "share_role" NOT NULL DEFAULT 'VIEWER',
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "share_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "share_grants" (
    "id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    "data_room_id" UUID NOT NULL,
    "invitee_email" TEXT NOT NULL,
    "role" "share_role" NOT NULL DEFAULT 'VIEWER',
    "revoked_at" TIMESTAMP(3),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "share_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upload_intents" (
    "id" UUID NOT NULL,
    "data_room_id" UUID NOT NULL,
    "parent_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "declared_size" BIGINT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "result_node_id" UUID,
    "result_version_id" UUID,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "upload_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_blob_deletions" (
    "id" UUID NOT NULL,
    "storage_key" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_blob_deletions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "data_rooms_root_node_id_key" ON "data_rooms"("root_node_id");

-- CreateIndex
CREATE INDEX "data_rooms_owner_id_created_at_idx" ON "data_rooms"("owner_id", "created_at");

-- CreateIndex
CREATE INDEX "nodes_parent_id_type_name_ci_id_idx" ON "nodes"("parent_id", "type", "name_ci", "id");

-- CreateIndex
CREATE INDEX "nodes_data_room_id_idx" ON "nodes"("data_room_id");

-- CreateIndex
CREATE UNIQUE INDEX "nodes_parent_id_name_ci_key" ON "nodes"("parent_id", "name_ci");

-- CreateIndex
CREATE UNIQUE INDEX "file_versions_storage_key_key" ON "file_versions"("storage_key");

-- CreateIndex
CREATE UNIQUE INDEX "file_versions_node_id_version_number_key" ON "file_versions"("node_id", "version_number");

-- CreateIndex
CREATE UNIQUE INDEX "share_links_token_key" ON "share_links"("token");

-- CreateIndex
CREATE INDEX "share_links_node_id_idx" ON "share_links"("node_id");

-- CreateIndex
CREATE INDEX "share_grants_data_room_id_invitee_email_idx" ON "share_grants"("data_room_id", "invitee_email");

-- CreateIndex
CREATE UNIQUE INDEX "share_grants_node_id_invitee_email_key" ON "share_grants"("node_id", "invitee_email");

-- CreateIndex
CREATE UNIQUE INDEX "upload_intents_storage_key_key" ON "upload_intents"("storage_key");

-- CreateIndex
CREATE INDEX "upload_intents_expires_at_idx" ON "upload_intents"("expires_at");

-- CreateIndex
CREATE INDEX "pending_blob_deletions_created_at_idx" ON "pending_blob_deletions"("created_at");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_rooms" ADD CONSTRAINT "data_rooms_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_rooms" ADD CONSTRAINT "data_rooms_root_node_id_fkey" FOREIGN KEY ("root_node_id") REFERENCES "nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_data_room_id_fkey" FOREIGN KEY ("data_room_id") REFERENCES "data_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_versions" ADD CONSTRAINT "file_versions_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_versions" ADD CONSTRAINT "file_versions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_data_room_id_fkey" FOREIGN KEY ("data_room_id") REFERENCES "data_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "share_grants" ADD CONSTRAINT "share_grants_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "share_grants" ADD CONSTRAINT "share_grants_data_room_id_fkey" FOREIGN KEY ("data_room_id") REFERENCES "data_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_intents" ADD CONSTRAINT "upload_intents_data_room_id_fkey" FOREIGN KEY ("data_room_id") REFERENCES "data_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_intents" ADD CONSTRAINT "upload_intents_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_intents" ADD CONSTRAINT "upload_intents_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================================
-- Database-level guarantees that schema.prisma cannot express.
-- Each one exists because the alternative is developer discipline, and discipline
-- loses races and gets dropped during refactors.
-- ============================================================================

-- Extensions are created here, not only by the Compose init script: managed
-- Postgres (Neon) has no init scripts.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- --- name_ci: Postgres is the single owner ----------------------------------
-- JS toLowerCase() and PG lower() disagree. Reproduced with 'İSTANBUL.PDF':
-- Postgres yields 'istanbul.pdf', JavaScript yields 'i̇stanbul.pdf' (i + combining
-- dot above). If the application filled this column, the CHECK below would turn a
-- legitimate filename into a 500.
CREATE OR REPLACE FUNCTION nodes_set_name_ci() RETURNS trigger AS $fn$
BEGIN
  NEW.name_ci := lower(NEW.name);
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER nodes_set_name_ci_trg
  BEFORE INSERT OR UPDATE OF name ON nodes
  FOR EACH ROW EXECUTE FUNCTION nodes_set_name_ci();

-- Backstop for any path that would assign name_ci directly, bypassing the trigger.
ALTER TABLE nodes ADD CONSTRAINT nodes_name_ci_matches CHECK (name_ci = lower(name));

-- --- path shape -------------------------------------------------------------
-- Every prefix scan depends on the surrounding slashes: without them the prefix
-- '/a/b/' would also match '/a/bc/' — a silently wrong result set instead of an error.
ALTER TABLE nodes ADD CONSTRAINT nodes_path_shape CHECK (path LIKE '/%/');

-- Nesting limit: guards against pathological trees and runaway recursion in the UI.
ALTER TABLE nodes ADD CONSTRAINT nodes_depth_bounds CHECK (depth >= 0 AND depth <= 32);

-- --- uniqueness rules Prisma cannot express ---------------------------------
-- Exactly one root per data room. NULLs are not compared in the
-- @@unique([parent_id, name_ci]) index, so without this a room could end up with two.
CREATE UNIQUE INDEX nodes_single_root_key ON nodes (data_room_id) WHERE parent_id IS NULL;

-- At most one current version per file.
CREATE UNIQUE INDEX file_versions_one_current ON file_versions (node_id) WHERE is_current;

-- One active public link per node: the UI shows a single toggle and a single
-- "Copy link" button, so N links per node would be a model/interface mismatch.
CREATE UNIQUE INDEX share_links_one_active ON share_links (node_id) WHERE revoked_at IS NULL;

-- --- indexes for specific queries -------------------------------------------
-- Subtree prefix scan: stats, delete, move. text_pattern_ops is required because the
-- default operator class does not serve LIKE 'prefix%' under a non-C collation.
CREATE INDEX nodes_path_prefix_idx ON nodes (data_room_id, path text_pattern_ops);

-- Filename substring search scoped to a data room. The leading uuid column inside a
-- GIN index is possible thanks to btree_gin.
CREATE INDEX nodes_name_trgm_idx ON nodes USING gin (data_room_id, name_ci gin_trgm_ops);

-- --- defaults for updated_at ------------------------------------------------
-- Prisma implements @updatedAt on the client, so in the database the column stays
-- NOT NULL with no default and any raw INSERT fails. Raw SQL is not rare here
-- (ON CONFLICT name allocation, keyset listing, prefix scans), so the column has to
-- be self-sufficient at the database level.
ALTER TABLE nodes      ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE data_rooms ALTER COLUMN updated_at SET DEFAULT now();
