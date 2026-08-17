import type { BreadcrumbDto, NodeDto } from '../nodes/dto/node.dto';
import type { ResolvedAccess } from './access.service';

/**
 * Trims read responses to what the actor is allowed to know about.
 *
 * Truncating breadcrumbs is the obvious part and the least important one. The leaks that
 * matter are elsewhere: a guest handed a link to `/Acme/03 Legal/NDAs` must not learn that
 * `03 Legal` exists, and that name would otherwise arrive through the node's own
 * `parentId`, through a search result's path, or through version history naming the
 * employee who uploaded a file.
 *
 * Everything a guest can read goes through here, so the rule is applied once rather than
 * remembered at each endpoint.
 */
export function projectNode(node: NodeDto, access: ResolvedAccess): NodeDto {
  if (node.id !== access.accessRoot.id) return node;

  // At the boundary the parent exists but is not visible. Reporting its id would both leak
  // it and make the client render a broken "up" affordance.
  return { ...node, parentId: null };
}

/**
 * Keeps only the trail from the access root downwards, inclusive.
 *
 * Breadcrumbs arrive root-first. For an owner the access root is the data room itself, so
 * nothing is removed; for a guest everything above the shared node disappears, and the
 * shared node becomes the top of the trail.
 */
export function projectBreadcrumbs(
  breadcrumbs: BreadcrumbDto[],
  access: ResolvedAccess,
): BreadcrumbDto[] {
  const boundary = breadcrumbs.findIndex((crumb) => crumb.id === access.accessRoot.id);
  return boundary === -1 ? [] : breadcrumbs.slice(boundary);
}
