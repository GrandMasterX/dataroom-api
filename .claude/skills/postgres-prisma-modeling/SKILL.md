---
name: postgres-prisma-modeling
description: Rules for schema design, indexes, migrations and query performance with PostgreSQL + Prisma in this project — constraints over application checks, keyset pagination instead of OFFSET, where raw SQL is allowed and how to parameterize it, verifying plans with EXPLAIN against seeded data, partial and expression indexes, CHECK constraints for derived columns, cascade behaviour, and migration review. Use whenever you edit schema.prisma, write or review a migration, add a query or a filter/sort/pagination, see a slow endpoint, or wonder whether an index exists for a query.
---

# PostgreSQL + Prisma rules

Two failure modes dominate here: a rule enforced in application code that the database would have
enforced absolutely, and a query whose plan nobody ever looked at. Both are cheap to prevent and
expensive to discover in production.

## Let the database enforce what it can

Application-level checks are advisory: they run for the caller who remembered them, and they lose every
race. Prefer, in this order:

1. **Unique index** for uniqueness — including expression and partial variants
   (`(parent_id, name_ci)`, `(data_room_id) WHERE parent_id IS NULL`).
2. **CHECK constraint** for derived-column agreement (`name_ci = lower(name)`). A derived column with no
   constraint is two sources of truth waiting to diverge.
3. **Foreign key with `ON DELETE CASCADE`** for ownership — a self-referencing FK cascades a whole
   subtree in one statement, which is both faster and more correct than deleting level by level.
4. Application check only for rules the database cannot express, and then in exactly one service.

Corollary: catching the constraint violation is the primary path for a plain "reject the duplicate"
operation. Map the Postgres error code (Prisma `P2002`) to a domain error rather than pre-checking with a
`SELECT`, which races.

The exception worth knowing, because the obvious code is broken: when the operation must *pick the next
free value* (an auto-suffixed name, a next version number), you cannot insert-catch-retry inside one
transaction. The first violation aborts the whole PostgreSQL transaction — every later statement returns
`current transaction is aborted, commands ignored until end of transaction block` and the commit is lost.
Either retry with one transaction per attempt, or serialize the operation with an advisory lock and then
read-then-insert inside it. `SAVEPOINT` also works at the SQL level, but Prisma's interactive transactions
do not expose it. The constraint stays regardless as the backstop that proves the serialization held.

## Indexes: name the query before you add the column

For each query, know its access path before writing it. The sort order in the index must match the
`ORDER BY` exactly, including the leading equality columns — `(parent_id, type, name_ci, id)` serves
`WHERE parent_id = ? ORDER BY type, name_ci, id` as a single seek, while any reordering degrades it to a
sort.

- Case-insensitive sorting and uniqueness use the stored `name_ci` column rather than `lower(name)` in
  the query, so Prisma can express both the index and the ordering.
- Prefix scans over a materialized path need `text_pattern_ops`; the default operator class does not
  serve `LIKE 'prefix%'` under non-C collations. Two consequences, both verified by `EXPLAIN` on a
  100k-row table, both counterintuitive enough that someone will "fix" them back:
  - **The prefix must be a constant or a bound parameter, never a subquery.** `path LIKE $1` uses the
    index (Postgres derives `~>=~` / `~<~` bounds from the value); `path LIKE (SELECT ...) || '%'`
    cannot be turned into bounds and seq-scans. So read the row first, then pass its path as a
    parameter — one extra round trip buys the index.
  - **Do not "optimize" `LIKE` into hand-written `>=` / `<` bounds.** A `text_pattern_ops` index
    implements the `~>=~` / `~<~` operator family, not the collation-aware `>=` / `<`, so the manual
    version silently drops to a seq scan while looking more explicit.
- Substring search uses a GIN trigram index (`pg_trgm`); scoping it with a leading equality column
  requires `btree_gin`. A trigram index on the whole table plus a filter afterwards reads far more than
  it must.
- Declare enum values in the order you want them sorted — Postgres orders an enum by declaration, which
  turns "folders before files" into a free index property instead of a `CASE` expression that no index
  can serve.

**Verify, don't assume.** Run `EXPLAIN (ANALYZE, BUFFERS)` against a seeded database — thousands of
rows, not five — and confirm the expected index appears and no `Sort` node is doing the ordering. On an
empty table every plan looks fine, which is why reading the query is not verification.

## Pagination

Keyset only:

```sql
WHERE parent_id = $1 AND (type, name_ci, id) > ($2, $3, $4)
ORDER BY type, name_ci, id LIMIT $5
```

`OFFSET` reads and discards every skipped row, and under concurrent inserts it skips or repeats rows
across pages. The cursor encodes the full sort tuple, and the tuple ends in a unique column so ties
cannot stall the scan. If a sort key can be mutated (a rename changes `name_ci`), say in the API docs
that a concurrent rename may move an item across pages — that is inherent to keyset paging over mutable
keys, and pretending otherwise leads to a wrong "fix".

## Raw SQL boundaries

Prisma covers most work; raw SQL is correct for tuple comparison, prefix scans, `count(*) FILTER (...)`
aggregates and advisory locks. When you use it:

- Always `Prisma.sql` / `$queryRaw` with parameters. String interpolation into SQL is an injection
  defect regardless of how internal the value looks.
- **Cast every parameter that lands in an overloaded function or an enum comparison.** An untyped
  parameter makes PostgreSQL pick an overload, and it can pick the wrong one silently. The case that
  cost real debugging time: `substring(path FROM $1)` resolves to the *regex* form
  `substring(string FROM pattern)`, which finds no match and returns **NULL** instead of raising —
  so a subtree update wrote NULL into every row rather than failing. `substring(path FROM $1::int)`
  is unambiguous. Enum comparisons need the same (`$1::node_type`), though those at least error
  instead of returning nonsense.
- Type the result explicitly; a raw query returns `unknown` shapes, and `bigint`/`Decimal` come back as
  JS types the rest of the code may not expect.
- Leave a one-line comment saying which Prisma limitation forced it. Otherwise the next person
  "simplifies" it back into a query builder call and silently loses the index.

## Migrations

- Extensions (`pg_trgm`, `btree_gin`) are created idempotently in the first migration, because managed
  Postgres has no init scripts.
- Test each migration on **both** a fresh database and a database with data. `ALTER TABLE ... ADD
  CONSTRAINT` on a populated table can fail where an empty table succeeds; the CHECK for a derived
  column is a typical case (existing rows must already satisfy it).
- Prisma runs a migration in a transaction, so statements that cannot run there (`CREATE INDEX
  CONCURRENTLY`) need their own migration file. On an empty MVP table a plain `CREATE INDEX` is right;
  note in the migration that the concurrent form is required once the table is large, so the next person
  does not lock a live table.
- Never edit an applied migration. Add a new one — an edited migration is applied in one environment and
  not another, and the drift is invisible.

## Types at the boundary

`BigInt` and `Decimal` do not survive `JSON.stringify`. Convert at one documented boundary (the response
mapper) and state the safe range there. A global serializer patch is worse: it changes behaviour for
logs and background jobs too, far from anywhere a reader will look.

## Review checklist

1. Every new query names the index it uses; `EXPLAIN` was run against seeded data.
2. Every uniqueness/derivation rule is a constraint; a `SELECT` before the insert exists only where the
   operation picks the next free value, and then only under the serializing lock (see above).
3. Pagination is keyset; no `OFFSET` in list endpoints.
4. Raw SQL is parameterized, typed, and carries its "why raw" comment.
5. Migration applies on both fresh and populated databases.
6. Cascade behaviour is explicit and tested for the deepest supported nesting.
7. `BigInt`/`Decimal` conversion happens only at the documented mapper boundary.
