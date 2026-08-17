/**
 * Materialized-path helpers.
 *
 * `parent_id` is the source of truth for the tree; `path` is a derived index that makes
 * subtree totals, deletes and moves single-statement operations. Because it is derived,
 * exactly one place may compute it — these functions — and everything else calls them.
 * Two writers of a derived column diverge; it is a question of when, not whether.
 *
 * Shape: `/{rootId}/{...}/{selfId}/`. The surrounding slashes are what make prefix
 * matching safe: without them the prefix `/a/b/` would also match `/a/bc/`. A CHECK
 * constraint in the migration pins the shape at the database level too.
 */

export const MAX_DEPTH = 32;

/** Path of a data room's root node, which has no parent. */
export function buildRootPath(rootNodeId: string): string {
  return `/${rootNodeId}/`;
}

/** Path of a child, derived from its parent's path. */
export function buildChildPath(parentPath: string, childId: string): string {
  return `${parentPath}${childId}/`;
}

/**
 * Depth implied by a path: the root is 0. Derived from the path rather than stored
 * independently so the two cannot disagree.
 */
export function depthFromPath(path: string): number {
  return path.split('/').filter(Boolean).length - 1;
}

/**
 * Ancestor ids, closest-last, excluding the node itself.
 *
 * Used for breadcrumbs (one `WHERE id IN (...)` query instead of walking parents, which
 * would be an N+1 that grows with nesting) and for rollup updates.
 */
export function ancestorIdsFromPath(path: string): string[] {
  const ids = path.split('/').filter(Boolean);
  return ids.slice(0, -1);
}

/** Whether `candidate` is the node itself or one of its ancestors. */
export function isAncestorOrSelfByPath(candidateId: string, path: string): boolean {
  return path.includes(`/${candidateId}/`);
}

/**
 * Whether `targetPath` lies inside the subtree rooted at `nodePath` (inclusive).
 *
 * This is the check that stops a folder from being moved into its own descendant, which
 * would detach the subtree from every listing while leaving the rows in place.
 */
export function isInSubtree(nodePath: string, targetPath: string): boolean {
  return targetPath.startsWith(nodePath);
}

/**
 * Rewrites a descendant's path when its ancestor moves.
 *
 * Mirrors the SQL used for the bulk subtree update, and exists so unit tests can pin the
 * offset arithmetic that is easy to get wrong by one character.
 */
export function rebasePath(path: string, oldPrefix: string, newPrefix: string): string {
  if (!path.startsWith(oldPrefix)) {
    throw new Error(`path ${path} is not inside ${oldPrefix}`);
  }
  return newPrefix + path.slice(oldPrefix.length);
}
