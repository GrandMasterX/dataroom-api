-- An upload must outlive the deletion of its destination folder.
--
-- With ON DELETE CASCADE the intent disappeared along with the folder, so completing it
-- answered "upload not found" — indistinguishable from probing someone else's upload id,
-- and useless to a user whose folder was deleted mid-transfer. Clearing the reference
-- instead lets completion say exactly what happened.
ALTER TABLE "upload_intents" DROP CONSTRAINT "upload_intents_parent_id_fkey";
ALTER TABLE "upload_intents" ALTER COLUMN "parent_id" DROP NOT NULL;
ALTER TABLE "upload_intents" ADD CONSTRAINT "upload_intents_parent_id_fkey"
  FOREIGN KEY ("parent_id") REFERENCES "nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- NOTE: Prisma also generated statements dropping nodes_path_prefix_idx,
-- nodes_name_trgm_idx and the updated_at defaults. They were removed by hand.
-- Those objects cannot be expressed in schema.prisma, so every generated migration will
-- propose deleting them again. `pnpm db:verify` asserts they exist, which turns a silent
-- regression into a failed check.
