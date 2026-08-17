import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DomainError } from '../common/errors/domain-error';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { PrismaService } from '../prisma/prisma.service';

export interface TokenPair {
  accessToken: string;
  /** Opaque; only its sha256 is stored, so it cannot be recovered from the database. */
  refreshToken: string;
  accessTokenExpiresInSeconds: number;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
}

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async issuePair(user: AuthenticatedUser): Promise<TokenPair> {
    const refreshToken = randomBytes(32).toString('base64url');

    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hash(refreshToken),
        expiresAt: this.refreshExpiry(),
      },
    });

    return {
      accessToken: await this.signAccessToken(user),
      refreshToken,
      accessTokenExpiresInSeconds: this.config.accessTokenTtlSeconds,
    };
  }

  /**
   * Exchanges a refresh token for a new pair, rotating the old one out.
   *
   * Two behaviours here exist because of a failure mode that is easy to miss until it
   * happens to a real user:
   *
   *  - **Reuse detection.** A token presented after it was already rotated is either a
   *    replay or a stolen copy, so the whole family for that user is revoked. Losing the
   *    session is the correct outcome; keeping it would leave an attacker with a valid
   *    chain.
   *
   *  - **A grace window that suspends that rule.** Several browser tabs refetching after
   *    the access token expires all send the same refresh token within milliseconds. Under
   *    a strict rule, the first rotation succeeds and the rest look exactly like a replay,
   *    so the user is signed out for using the app normally. Inside the window the request
   *    is treated as the same rotation and simply issues a fresh pair.
   *
   * The frontend also single-flights refresh; this is the backstop for when it cannot (two
   * tabs, two processes). The accepted cost is a small window in which a leaked, already
   * rotated token still works — bounded by REFRESH_ROTATION_GRACE_SECONDS.
   */
  async rotate(presentedToken: string): Promise<{ user: AuthenticatedUser; tokens: TokenPair }> {
    const tokenHash = hash(presentedToken);

    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: { select: { id: true, email: true, displayName: true } } },
    });

    if (!existing) throw DomainError.unauthenticated('Session expired, please sign in again');
    if (existing.expiresAt.getTime() <= Date.now()) {
      throw DomainError.unauthenticated('Session expired, please sign in again');
    }

    if (existing.revokedAt) {
      // Why the token was revoked decides what happens next, and conflating the two cases
      // makes sign-out a suggestion. `replacedById` is set only by rotation, so:
      //   - rotated (replacedById set) -> possibly a concurrent refresh; the grace window
      //     applies, because otherwise normal multi-tab use looks like a replay.
      //   - explicitly revoked (replacedById null) -> sign-out, or a session already
      //     terminated by reuse detection. Never accepted, grace or not.
      const wasRotated = existing.replacedById !== null;
      const secondsSinceRevoked = (Date.now() - existing.revokedAt.getTime()) / 1000;
      const withinGrace = secondsSinceRevoked <= this.config.refreshRotationGraceSeconds;

      if (!wasRotated) {
        throw DomainError.unauthenticated('Session expired, please sign in again');
      }
      if (!withinGrace) {
        await this.revokeAllForUser(existing.userId);
        this.logger.warn(
          `Refresh token reuse detected for user ${existing.userId}; revoked all sessions`,
        );
        throw DomainError.unauthenticated('Session expired, please sign in again');
      }
    }

    const refreshToken = randomBytes(32).toString('base64url');

    await this.prisma.$transaction(async (tx) => {
      const created = await tx.refreshToken.create({
        data: {
          userId: existing.userId,
          tokenHash: hash(refreshToken),
          expiresAt: this.refreshExpiry(),
        },
        select: { id: true },
      });
      await tx.refreshToken.update({
        where: { id: existing.id },
        data: { revokedAt: existing.revokedAt ?? new Date(), replacedById: created.id },
      });
    });

    return {
      user: existing.user,
      tokens: {
        accessToken: await this.signAccessToken(existing.user),
        refreshToken,
        accessTokenExpiresInSeconds: this.config.accessTokenTtlSeconds,
      },
    };
  }

  /** Sign-out. Unknown or already-revoked tokens succeed silently: the caller's intent is met. */
  async revoke(presentedToken: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: hash(presentedToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private signAccessToken(user: AuthenticatedUser): Promise<string> {
    return this.jwt.signAsync(
      { sub: user.id, email: user.email },
      { secret: this.config.jwtAccessSecret, expiresIn: this.config.accessTokenTtlSeconds },
    );
  }

  private refreshExpiry(): Date {
    return new Date(Date.now() + this.config.refreshTokenTtlDays * 24 * 60 * 60 * 1000);
  }
}

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

