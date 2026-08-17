import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { DomainError } from '../common/errors/domain-error';
import { isUniqueViolation, UniqueIndex } from '../common/errors/prisma-error';
import { PrismaService } from '../prisma/prisma.service';
import type { SessionDto } from './dto/auth.dto';
import { TokenService, type AuthenticatedUser } from './token.service';

/**
 * OWASP's recommended argon2id profile. Kept here as named constants because "why 19456"
 * is the first question a reviewer asks, and the answer belongs next to the number.
 */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
  ) {}

  async register(input: {
    email: string;
    password: string;
    displayName: string;
  }): Promise<SessionDto> {
    const passwordHash = await argon2.hash(input.password, ARGON2_OPTIONS);

    let user: AuthenticatedUser;
    try {
      user = await this.prisma.user.create({
        data: { email: input.email, passwordHash, displayName: input.displayName },
        select: { id: true, email: true, displayName: true },
      });
    } catch (error) {
      // Uniqueness is enforced by the index, not by a prior existence check: two
      // simultaneous registrations with the same address would both pass such a check.
      if (isUniqueViolation(error, UniqueIndex.userEmail)) throw DomainError.emailTaken();
      throw error;
    }

    return this.toSession(user);
  }

  async login(input: { email: string; password: string }): Promise<SessionDto> {
    const user = await this.prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true, email: true, displayName: true, passwordHash: true },
    });

    // Verify against a dummy hash when the address is unknown, so a missing account and a
    // wrong password take comparable time and return the identical error. Otherwise the
    // endpoint doubles as an "is this person a customer" oracle — which, for a data room,
    // leaks who is involved in a deal.
    const passwordHash = user?.passwordHash ?? (await dummyHash());
    const passwordMatches = await argon2.verify(passwordHash, input.password).catch(() => false);

    if (!user || !passwordMatches) throw DomainError.invalidCredentials();

    return this.toSession({ id: user.id, email: user.email, displayName: user.displayName });
  }

  async refresh(refreshToken: string): Promise<SessionDto> {
    const { user, tokens } = await this.tokens.rotate(refreshToken);
    return { user, ...tokens };
  }

  async logout(refreshToken: string): Promise<void> {
    await this.tokens.revoke(refreshToken);
  }

  async currentUser(userId: string): Promise<AuthenticatedUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, displayName: true },
    });
    // The token was valid but the account is gone: treat as unauthenticated rather than
    // 404, because the caller's session is what is invalid.
    if (!user) throw DomainError.unauthenticated();
    return user;
  }

  private async toSession(user: AuthenticatedUser): Promise<SessionDto> {
    const tokens = await this.tokens.issuePair(user);
    return { user, ...tokens };
  }
}

/**
 * A real argon2id hash of a random value, so verifying against it costs the same as a
 * genuine check. Computed on first use and cached: argon2 exposes no synchronous hash, and
 * hashing at module load would add ~50 ms to every process start including tests.
 */
let cachedDummyHash: Promise<string> | undefined;

function dummyHash(): Promise<string> {
  cachedDummyHash ??= argon2.hash(randomBytes(32).toString('hex'), ARGON2_OPTIONS);
  return cachedDummyHash;
}
