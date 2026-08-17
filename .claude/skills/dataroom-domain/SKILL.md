---
name: dataroom-domain
description: Invariants, algorithms and review checklist for the Data Room tree and sharing model — Node/path/depth maintenance, name-conflict resolution, subtree stats and delete, ShareLink/ShareGrant, resolveAccess and 404-vs-403. Use this whenever you write, change or review code that creates/renames/moves/deletes/lists nodes, computes breadcrumbs or subtree size, issues or revokes shares, checks permissions, or writes a migration touching Node/Share/FileVersion — and also when a bug report mentions "wrong folder", "duplicate name", "guest can see", "revoke didn't work", or "breadcrumbs".
---

# Data Room domain rules

This codebase stores folders and files as **one** `Node` table forming a tree, and grants read access
through two share mechanisms. Almost every defect in this domain is one of three kinds: a derived
column that stopped matching its source, a permission check that failed open, or a uniqueness rule
enforced in application code instead of the database. The rules below exist to make those three
impossible rather than merely unlikely.

## The invariants

Treat these as the contract. If a change cannot preserve one, stop and say so instead of weakening it.

| # | Invariant | What goes wrong when it breaks |
|---|---|---|
| I1 | `parentId` is the source of truth; `path` is derived: `'/' + ancestorIds.join('/') + '/' + selfId + '/'` | Subtree queries silently return the wrong set — no error, wrong data |
| I2 | `path` and `parentId` change only together, in one transaction | A node is listed in one folder and counted in another |
| I3 | `depth = count('/', path) - 2`, max 32 | Unbounded recursion in UI and pathological updates |
| I4 | Every node in a `path` belongs to the same `dataRoomId`; cross-room moves are rejected | A share on room A leaks a node from room B |
| I5 | `type = FILE` ⟺ `currentVersionId IS NOT NULL` | Files with no bytes, folders that pretend to have size |
| I6 | Move target may not be the node itself or any descendant (`target.path` must not start with `node.path`) | Detached cycle: subtree disappears from every listing but still exists |
| I7 | `nameCi = lower(name)`, enforced by a DB CHECK, and name uniqueness within a parent is enforced by a unique index | Two files with the same name in one folder; renames that "work" then collide |

Only `NodeTreeService` writes `path`, `depth`, `nameCi` and `parentId`. If you find these assigned
anywhere else, that is the bug — move the logic, do not add a second writer. Two writers of a derived
column diverge; it is a question of when, not whether.

## Operation checklists

### Create (folder or file node)
- Compute `path`/`depth` from the parent that was **read in this transaction**, not from a value passed
  by the caller — a caller-supplied path is a caller-supplied bug.
- Take the per-room advisory lock. Every tree mutation takes it — create, rename, move, delete and
  upload completion — not only move.
- With the `fail` strategy, insert once and let the unique index reject duplicates: catch Prisma `P2002`
  and map it to the domain conflict.
- With the auto-`rename` strategy, compute the free name with a `SELECT` **inside the lock**, then insert
  once. This looks like the "check then insert" race, and it would be one without the lock — the lock is
  what makes it correct, so the two must never be separated.

  Why not "insert, catch the violation, try the next suffix" in a loop? Because a failed statement
  poisons the whole PostgreSQL transaction: the next statement returns `current transaction is aborted,
  commands ignored until end of transaction block` and nothing commits. (Verified by execution, not
  inferred: the loop version committed zero rows.) `SAVEPOINT` per attempt does work, but Prisma's
  interactive transactions do not expose savepoints, so the retry would have to leave the transaction.
- Therefore a `P2002` that still surfaces means a code path skipped the lock. Return the conflict to the
  client and do not attempt in-transaction recovery — the transaction is already dead.

### Rename
- Same conflict path as create, so both go through one `resolveName(parentId, desired, strategy)`.
- The `rename` strategy appends ` (2)`, ` (3)` **before the extension** and must not nest (`doc (2) (2).pdf`
  means the suffix parser is wrong). Bound the attempts and fail loudly at the bound.
- Renaming never touches `path` — `path` holds ids, not names. If a rename changes `path`, something
  reconstructed it from names; that is a serious bug, not a cosmetic one.

### Move
- Order matters: take the per-room advisory lock, re-read both nodes `FOR UPDATE`, then validate
  I4 and I6, then resolve the name conflict, then update `parentId`, then rewrite the subtree `path`
  prefix in a single `UPDATE`.
- The lock is what makes I6 hold. Without it, "move A into B" and "move B into A" can both pass
  validation and produce a cycle. Do not replace it with a post-hoc check.
- Compute the depth delta and apply it to the whole subtree; a moved subtree that keeps stale `depth`
  breaks the max-depth guard for every future move.

### Delete
- Collect storage keys for **all versions** in the subtree before deleting rows — after the cascade the
  keys are gone and the blobs are unreachable forever.
- Delete DB rows in the transaction, delete blobs **after commit**, best effort. This ordering is
  deliberate: an orphaned blob costs pennies and is collectable, while a deleted blob whose transaction
  rolled back is unrecoverable data loss. Never reverse it to "clean up first".
- Report what will be deleted before deleting: the subtree counts and size come from the stats query,
  not from a client-side guess.

### List / breadcrumbs / stats
- Listing is always scoped by `parentId` and paginated by keyset over `(type, nameCi, id)`. `OFFSET`
  is wrong here even when it looks fine at 20 rows — it degrades linearly and skips rows under
  concurrent inserts.
- Breadcrumbs come from parsing ids out of `path` plus one `WHERE id IN (...)` query. Never walk
  parents in a loop; that is an N+1 that grows with nesting depth.
- Subtree stats use the `path LIKE prefix || '%'` range scan. If you add a rollup cache later, the
  exact query stays as the correctness reference.

## Access control

There is exactly one function that answers "may this actor read this node": `resolveAccess`. Every
endpoint goes through it. A second permission check written inline in a controller is a second answer
to the same question, and the two will disagree.

- Ancestor-or-self is tested against ids parsed from `path` — no extra query, and it keeps working when
  the share target is 5 levels above the requested node.
- **No access on a read returns 404, not 403.** 403 confirms the resource exists, which is itself a
  leak in a due-diligence product. 403 is reserved for "you may read this but not modify it".
- A guest's breadcrumbs are truncated to the share root, and every read is validated as "inside the
  share root's subtree", not merely "exists". Truncating the display without validating the request is
  cosmetic security: the guest just calls the API with an ancestor id.
- Nested shares combine as **maximum role**. Fix this rule in one place; when EDITOR arrives, the rule
  must not need re-deciding.
- Revocation and expiry are checked at resolve time, never cached in a session. "Revoke" that leaves an
  active session working is a failed requirement, not a delay.

## When you add a permission or a share mode

Add the capability to the role matrix (`can(action, role)`) and to `resolveAccess`. If you find yourself
adding a boolean like `isPublic` next to `role`, stop: that is a second permission model. Two models
mean every future check must consult both, and one of them will be forgotten.

## What the tests must pin

A test that would still pass if the behaviour were broken is worse than no test, because it reports
safety it does not provide. For each of these, break the code deliberately and confirm the test goes red:

- `path`/`depth` correct after create and after moving a 3-level subtree (mutate: drop the subtree
  `UPDATE` → the test must fail).
- Move into own descendant, move into self, cross-room move → all rejected (mutate: remove the I6 check).
- `resolveName` suffixing: no nesting, extension preserved, bound respected.
- `resolveAccess`: owner, valid link, expired link, revoked link, grant on ancestor, grant on unrelated
  node, wrong room, guest requesting an ancestor above the share root → each with its own assertion.
- Deletion collects keys for non-current versions too (mutate: filter to `currentVersionId` only).
- Concurrent same-name creation resolves to one success and one conflict — run it against a real
  database, because this test exists to prove the *index* works, and a mocked Prisma client cannot.
