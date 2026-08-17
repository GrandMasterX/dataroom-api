import {
  ancestorIdsFromPath,
  buildChildPath,
  buildRootPath,
  depthFromPath,
  isAncestorOrSelfByPath,
  isInSubtree,
  rebasePath,
} from './node-path';

/**
 * Pure path arithmetic. The subtree-rewrite offset here is the same arithmetic the bulk
 * SQL performs during a move, and an off-by-one there silently relocates a subtree, so it
 * is worth pinning in isolation as well as against the database.
 */
describe('node-path', () => {
  const root = 'aaaaaaaa-0000-0000-0000-000000000000';
  const mid = 'bbbbbbbb-0000-0000-0000-000000000000';
  const leaf = 'cccccccc-0000-0000-0000-000000000000';

  const rootPath = buildRootPath(root);
  const midPath = buildChildPath(rootPath, mid);
  const leafPath = buildChildPath(midPath, leaf);

  it('builds paths delimited on both sides', () => {
    // The trailing slash is what stops '/a/b/' from matching '/a/bc/'.
    expect(rootPath).toBe(`/${root}/`);
    expect(leafPath).toBe(`/${root}/${mid}/${leaf}/`);
  });

  it('derives depth with the root at zero', () => {
    expect(depthFromPath(rootPath)).toBe(0);
    expect(depthFromPath(midPath)).toBe(1);
    expect(depthFromPath(leafPath)).toBe(2);
  });

  it('lists ancestors closest-last and excludes the node itself', () => {
    expect(ancestorIdsFromPath(leafPath)).toEqual([root, mid]);
    expect(ancestorIdsFromPath(rootPath)).toEqual([]);
  });

  it('recognises ancestors and the node itself', () => {
    expect(isAncestorOrSelfByPath(root, leafPath)).toBe(true);
    expect(isAncestorOrSelfByPath(leaf, leafPath)).toBe(true);
    expect(isAncestorOrSelfByPath('dddddddd-0000-0000-0000-000000000000', leafPath)).toBe(false);
  });

  it('does not confuse a sibling whose id shares a prefix', () => {
    // Substring matching without delimiters would report true here.
    const sibling = `${mid}9`;
    expect(isAncestorOrSelfByPath(sibling, leafPath)).toBe(false);
  });

  it('detects the move-into-own-descendant case', () => {
    expect(isInSubtree(midPath, leafPath)).toBe(true);
    expect(isInSubtree(midPath, midPath)).toBe(true); // moving into itself
    expect(isInSubtree(leafPath, midPath)).toBe(false);
  });

  it('rebases a descendant onto a new prefix', () => {
    const newParentPath = `/${root}/dddddddd-0000-0000-0000-000000000000/`;
    const movedMidPath = buildChildPath(newParentPath, mid);

    expect(rebasePath(leafPath, midPath, movedMidPath)).toBe(
      `${newParentPath}${mid}/${leaf}/`,
    );
    expect(depthFromPath(rebasePath(leafPath, midPath, movedMidPath))).toBe(3);
  });

  it('refuses to rebase a path that is not inside the old prefix', () => {
    // Failing loudly matters more than being lenient: a silent no-op here would leave
    // half a subtree pointing at its old location.
    expect(() => rebasePath(rootPath, midPath, '/x/')).toThrow();
  });
});
