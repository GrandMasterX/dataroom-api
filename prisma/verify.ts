import 'dotenv/config';
import { Pool } from 'pg';

/**
 * Tree-consistency auditor: `pnpm db:verify`.
 *
 * `path` and `depth` are derived columns maintained by the application, so without a way
 * to detect drift the only symptom of a bug would be a silently wrong result set. This
 * script is that way. It runs after every integration suite and can be pointed at any
 * environment.
 *
 * It deliberately uses `pg` rather than Prisma: it audits what the ORM believes, so it
 * should not look at the data through the ORM's own mapping.
 *
 * Exit code 1 on any violation, so CI fails without anyone reading the output.
 */

interface Check {
  name: string;
  /** Explains what a violation would break, so a failure is actionable at 2am. */
  matters: string;
  /** Must return zero rows. Any row returned is a violation; `sample` is shown. */
  sql: string;
}

const checks: Check[] = [
  {
    name: 'path matches parent path',
    matters: 'subtree scans would silently return the wrong set of rows',
    sql: `
      SELECT n.id::text AS sample
      FROM nodes n JOIN nodes p ON p.id = n.parent_id
      WHERE n.path <> p.path || n.id::text || '/'`,
  },
  {
    name: 'root path is /rootId/',
    matters: 'breadcrumbs and prefix scans start from the root path',
    sql: `
      SELECT id::text AS sample FROM nodes
      WHERE parent_id IS NULL AND path <> '/' || id::text || '/'`,
  },
  {
    name: 'depth agrees with path',
    matters: 'the nesting guard is computed from depth; a stale value lets the tree grow past the limit',
    sql: `
      SELECT id::text AS sample FROM nodes
      WHERE depth <> array_length(string_to_array(trim(both '/' from path), '/'), 1) - 1`,
  },
  {
    name: 'path contains own id exactly once',
    matters: 'a duplicated id means a cycle was created by a bad move',
    sql: `
      SELECT id::text AS sample FROM nodes
      WHERE (length(path) - length(replace(path, '/' || id::text || '/', ''))) <> length('/' || id::text || '/')`,
  },
  {
    name: 'subtree stays in one data room',
    matters: 'a cross-room parent would let a share on one room expose another room',
    sql: `
      SELECT n.id::text AS sample
      FROM nodes n JOIN nodes p ON p.id = n.parent_id
      WHERE n.data_room_id <> p.data_room_id`,
  },
  {
    name: 'every file has exactly one current version',
    matters: 'a file with no current version has no bytes to show and no size to count',
    sql: `
      SELECT n.id::text AS sample FROM nodes n
      WHERE n.type = 'FILE'
        AND (SELECT count(*) FROM file_versions v WHERE v.node_id = n.id AND v.is_current) <> 1`,
  },
  {
    name: 'folders have no versions',
    matters: 'a folder with versions would be counted in size totals',
    sql: `
      SELECT n.id::text AS sample FROM nodes n
      WHERE n.type = 'FOLDER'
        AND EXISTS (SELECT 1 FROM file_versions v WHERE v.node_id = n.id)`,
  },
  {
    name: 'each data room has exactly one root',
    matters: 'two roots split a room in half; zero roots make it unreachable',
    sql: `
      SELECT d.id::text AS sample FROM data_rooms d
      WHERE (SELECT count(*) FROM nodes n WHERE n.data_room_id = d.id AND n.parent_id IS NULL) <> 1`,
  },
  {
    name: 'data_rooms.root_node_id points at that room root',
    matters: 'the room would open at someone else’s folder, or at nothing',
    sql: `
      SELECT d.id::text AS sample FROM data_rooms d
      WHERE d.root_node_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM nodes n
          WHERE n.id = d.root_node_id AND n.data_room_id = d.id AND n.parent_id IS NULL)`,
  },
  {
    name: 'version numbers are contiguous from 1',
    matters: 'gaps mean a version was lost, and “version 3 of 2” confuses the history UI',
    sql: `
      SELECT node_id::text AS sample FROM file_versions
      GROUP BY node_id
      HAVING max(version_number) <> count(*) OR min(version_number) <> 1`,
  },
  {
    // Prisma cannot express these in schema.prisma, so it treats them as drift and every
    // generated migration proposes dropping them. Removing that line by hand is easy to
    // forget once; this check turns the silent regression into a failed run.
    name: 'hand-written database objects still exist',
    matters:
      'a generated migration can drop the trigger, the partial indexes or the prefix-scan index, and nothing else would notice',
    sql: `
      SELECT expected AS sample FROM (VALUES
        ('index:nodes_path_prefix_idx'), ('index:nodes_name_trgm_idx'),
        ('index:nodes_single_root_key'), ('index:file_versions_one_current'),
        ('index:share_links_one_active'),
        ('trigger:nodes_set_name_ci_trg'),
        ('check:nodes_name_ci_matches'), ('check:nodes_path_shape'), ('check:nodes_depth_bounds'),
        ('default:nodes.updated_at'), ('default:data_rooms.updated_at')
      ) AS required(expected)
      WHERE expected NOT IN (
        SELECT 'index:' || indexname FROM pg_indexes WHERE schemaname = 'public'
        UNION ALL
        SELECT 'trigger:' || tgname FROM pg_trigger WHERE NOT tgisinternal
        UNION ALL
        SELECT 'check:' || conname FROM pg_constraint WHERE contype = 'c'
        UNION ALL
        SELECT 'default:' || table_name || '.' || column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'updated_at' AND column_default IS NOT NULL
      )`,
  },
  {
    name: 'share targets belong to the recorded data room',
    matters: 'a mismatch makes the access check and the listing disagree about scope',
    sql: `
      SELECT s.id::text AS sample FROM share_links s JOIN nodes n ON n.id = s.node_id
      WHERE n.data_room_id <> s.data_room_id
      UNION ALL
      SELECT g.id::text FROM share_grants g JOIN nodes n ON n.id = g.node_id
      WHERE n.data_room_id <> g.data_room_id`,
  },
];

async function main(): Promise<void> {
  const connectionString = process.env.VERIFY_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL (or VERIFY_DATABASE_URL) is required');

  const pool = new Pool({ connectionString, max: 1 });
  let failures = 0;

  try {
    for (const check of checks) {
      const { rows } = await pool.query<{ sample: string }>(`${check.sql} LIMIT 5`);
      if (rows.length === 0) {
        console.log(`  ok    ${check.name}`);
        continue;
      }
      failures += 1;
      console.error(`  FAIL  ${check.name}`);
      console.error(`        breaks: ${check.matters}`);
      console.error(`        offending ids: ${rows.map((r) => r.sample).join(', ')}`);
    }
  } finally {
    await pool.end();
  }

  const { host } = new URL(connectionString);
  if (failures > 0) {
    console.error(`\n${failures} invariant(s) violated on ${host}`);
    process.exit(1);
  }
  console.log(`\nAll ${checks.length} tree invariants hold on ${host}`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
