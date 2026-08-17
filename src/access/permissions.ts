/**
 * The permission matrix. Every "may this actor do that" question in the API is answered
 * here and nowhere else — a second answer written inline in a controller is a second
 * source of truth, and the two will disagree.
 *
 * Adding EDITOR later is a row in this table plus a value in the ShareRole enum: no table
 * changes, no endpoint changes. That is the whole reason the matrix exists as data rather
 * than as scattered `if (isOwner)` checks.
 */
export type Role = 'OWNER' | 'VIEWER';

export type Action =
  | 'read'
  | 'create'
  | 'rename'
  | 'move'
  | 'delete'
  | 'upload'
  | 'share'
  | 'viewVersionHistory';

const MATRIX: Record<Role, ReadonlySet<Action>> = {
  OWNER: new Set<Action>([
    'read',
    'create',
    'rename',
    'move',
    'delete',
    'upload',
    'share',
    'viewVersionHistory',
  ]),
  // Read-only by definition. Version history is excluded deliberately: it names the people
  // who uploaded each version, which is internal information about the seller's team.
  VIEWER: new Set<Action>(['read']),
};

export function can(action: Action, role: Role): boolean {
  return MATRIX[role].has(action);
}

/** Combines roles when several grants apply to one node: the most permissive wins. */
export function highestRole(roles: Role[]): Role | undefined {
  if (roles.includes('OWNER')) return 'OWNER';
  if (roles.includes('VIEWER')) return 'VIEWER';
  return undefined;
}
