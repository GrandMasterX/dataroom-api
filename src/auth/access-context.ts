import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { DomainError } from '../common/errors/domain-error';

/**
 * Who is asking.
 *
 * Both fields can be present at once, and that is not an edge case: someone signed in to
 * their own account can legitimately open a public link to a different data room. Treating
 * the two as mutually exclusive would make that request resolve as the wrong identity.
 *
 * Access resolution takes the most permissive answer across whatever is present.
 */
export interface AccessContext {
  user?: { id: string; email: string };
  shareToken?: string;
}

export const REQUEST_CONTEXT_KEY = 'accessContext';

/** Injects the request's AccessContext, which the global context guard always populates. */
export const Ctx = createParamDecorator((_data: unknown, host: ExecutionContext): AccessContext => {
  const request = host.switchToHttp().getRequest<Record<string, unknown>>();
  return (request[REQUEST_CONTEXT_KEY] as AccessContext | undefined) ?? {};
});

/**
 * Injects the signed-in user, failing if there is none. Endpoints that mutate always need
 * a real user; read endpoints may be served by a share token instead.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, host: ExecutionContext): { id: string; email: string } => {
    const request = host.switchToHttp().getRequest<Record<string, unknown>>();
    const context = request[REQUEST_CONTEXT_KEY] as AccessContext | undefined;
    if (!context?.user) throw DomainError.unauthenticated();
    return context.user;
  },
);
