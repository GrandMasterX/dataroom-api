import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';

/**
 * Attempts allowed against one email address per window, overriding the global limit on the
 * credential endpoints. Deliberately not an environment variable: it is a security property
 * of those endpoints, and raising it should require a code review rather than a redeploy.
 */
export const AUTH_ATTEMPT_LIMIT = 10;
export const AUTH_ATTEMPT_WINDOW_MS = 60_000;

/**
 * The application's only rate-limiting guard, registered globally.
 *
 * It exists to fix the tracking key. The default guard counts per source IP, which is the
 * wrong unit here: the browser never talks to this API directly, so every request arrives
 * from the frontend's BFF and shares one address. An IP-keyed limit would throttle the
 * entire user base as a group while doing nothing to slow an attacker spreading guesses
 * across many accounts.
 *
 * So when a request carries an email address — which in practice means the credential
 * endpoints — attempts are counted against that address. Everything else falls back to the
 * forwarded client address, which is meaningful once the BFF passes it through.
 *
 * Registering exactly one guard also matters: adding a second throttler guard on a
 * controller does not replace the global one, it runs in addition to it, and the stricter
 * decorator limit then applies to the global guard's IP-based key as well — which collapses
 * every user into a single counter.
 */
@Injectable()
export class ApiThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(request: Request): Promise<string> {
    const body = request.body as { email?: unknown } | undefined;
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (email) return `email:${email}`;

    const forwarded = request.headers['x-forwarded-for'];
    const clientIp = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
    return `ip:${clientIp ?? request.ip ?? 'unknown'}`;
  }
}
