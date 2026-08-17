import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Inject } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { DomainError } from '../common/errors/domain-error';
import { AccessContext, REQUEST_CONTEXT_KEY } from './access-context';

export const REQUIRES_USER = 'requiresUser';

/**
 * Marks an endpoint as needing a signed-in user (as opposed to one that a share token may
 * also satisfy). Mutations always need it.
 */
export const RequireUser = (): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRES_USER, true);

/**
 * Builds the AccessContext for every request and, by default, lets the request through.
 *
 * It is a context builder rather than a gate because read endpoints are shared between the
 * owner and a guest holding a share token — the same controller serves both, so rejecting
 * unauthenticated requests here would require a second, parallel read API, and two copies
 * of one state machine drift apart.
 */
@Injectable()
export class AccessContextGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(host: ExecutionContext): Promise<boolean> {
    const request = host.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      [REQUEST_CONTEXT_KEY]?: AccessContext;
    }>();

    const context: AccessContext = {};

    const bearer = readHeader(request.headers.authorization)?.match(/^Bearer (.+)$/)?.[1];
    if (bearer) {
      try {
        const payload = await this.jwt.verifyAsync<{ sub: string; email: string }>(bearer, {
          secret: this.config.jwtAccessSecret,
        });
        context.user = { id: payload.sub, email: payload.email };
      } catch {
        // An expired or malformed token leaves the context anonymous rather than failing
        // here: the endpoint decides whether anonymous is acceptable. The frontend's
        // refresh flow depends on receiving 401 from the endpoint, not from the guard.
      }
    }

    const shareToken = readHeader(request.headers['x-share-token']);
    if (shareToken) context.shareToken = shareToken;

    request[REQUEST_CONTEXT_KEY] = context;

    const requiresUser = this.reflector.getAllAndOverride<boolean>(REQUIRES_USER, [
      host.getHandler(),
      host.getClass(),
    ]);
    if (requiresUser && !context.user) throw DomainError.unauthenticated();

    return true;
  }
}

function readHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}
