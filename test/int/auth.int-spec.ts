import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './app.harness';
import { prisma } from './setup';

/**
 * Auth behaviour end to end. The refresh-rotation cases are the reason this suite exists:
 * the strict version of reuse detection signs a user out for opening two browser tabs, and
 * that only shows up when several requests refresh at once.
 */
describe('auth', () => {
  const credentials = {
    email: 'Dana@Acme.com',
    password: 'correct horse battery',
    displayName: 'Dana Owner',
  };

  describe('with the default grace window', () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await createTestApp();
    });
    afterAll(async () => {
      await app?.close();
    });

    const http = () => request(app.getHttpServer());

    it('registers, normalising the email to lower case', async () => {
      const response = await http().post('/auth/register').send(credentials).expect(201);

      expect(response.body.user.email).toBe('dana@acme.com');
      expect(response.body.accessToken).toEqual(expect.any(String));
      expect(response.body.refreshToken).toEqual(expect.any(String));

      // Only the hash is stored: a database dump must not yield usable session tokens.
      const stored = await prisma.refreshToken.findFirstOrThrow();
      expect(stored.tokenHash).not.toBe(response.body.refreshToken);
      expect(stored.tokenHash).toHaveLength(64);
    });

    it('rejects a duplicate registration with a distinct code', async () => {
      await http().post('/auth/register').send(credentials).expect(201);
      const response = await http()
        .post('/auth/register')
        .send({ ...credentials, email: 'DANA@acme.com' })
        .expect(409);

      expect(response.body.error.code).toBe('EMAIL_TAKEN');
    });

    it('answers identically for a wrong password and an unknown address', async () => {
      // Mutation: return a different code or status for the unknown-user branch -> this
      // fails. The endpoint must not double as an "is this person a customer" oracle.
      await http().post('/auth/register').send(credentials).expect(201);

      const wrongPassword = await http()
        .post('/auth/login')
        .send({ email: credentials.email, password: 'not the password' })
        .expect(401);
      const unknownUser = await http()
        .post('/auth/login')
        .send({ email: 'nobody@acme.com', password: credentials.password })
        .expect(401);

      expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(unknownUser.body.error).toEqual(wrongPassword.body.error);
    });

    it('rejects a password shorter than the minimum with field errors', async () => {
      const response = await http()
        .post('/auth/register')
        .send({ ...credentials, password: 'short' })
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(response.body.error.details.fieldErrors.join(' ')).toMatch(/password/i);
    });

    it('rejects unknown fields instead of ignoring them', async () => {
      // A client that believes it set a field must not get a 200 while the server dropped
      // it — that is how privilege-shaped fields get silently ignored.
      const response = await http()
        .post('/auth/register')
        .send({ ...credentials, role: 'ADMIN' })
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('returns the current user for a valid access token and 401 without one', async () => {
      const session = await http().post('/auth/register').send(credentials).expect(201);

      await http()
        .get('/auth/me')
        .set('Authorization', `Bearer ${session.body.accessToken}`)
        .expect(200)
        .expect((res) => expect(res.body.email).toBe('dana@acme.com'));

      const anonymous = await http().get('/auth/me').expect(401);
      expect(anonymous.body.error.code).toBe('UNAUTHENTICATED');

      const garbage = await http().get('/auth/me').set('Authorization', 'Bearer nonsense').expect(401);
      expect(garbage.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('rotates the refresh token and keeps concurrent refreshes working', async () => {
      // This is the case that logs a real user out: several tabs refresh at once with the
      // same token. Inside the grace window the second attempt must succeed.
      // Mutation: remove the grace check from TokenService.rotate -> this fails.
      const session = await http().post('/auth/register').send(credentials).expect(201);
      const original = session.body.refreshToken;

      const first = await http().post('/auth/refresh').send({ refreshToken: original }).expect(200);
      expect(first.body.refreshToken).not.toBe(original);

      const concurrent = await http()
        .post('/auth/refresh')
        .send({ refreshToken: original })
        .expect(200);
      expect(concurrent.body.refreshToken).not.toBe(first.body.refreshToken);

      const user = await prisma.user.findUniqueOrThrow({ where: { email: 'dana@acme.com' } });
      expect(await prisma.refreshToken.count({ where: { userId: user.id, revokedAt: null } })).toBe(2);
    });

    it('stops accepting a refresh token after logout', async () => {
      const session = await http().post('/auth/register').send(credentials).expect(201);

      await http()
        .post('/auth/logout')
        .send({ refreshToken: session.body.refreshToken })
        .expect(204);

      const response = await http()
        .post('/auth/refresh')
        .send({ refreshToken: session.body.refreshToken })
        .expect(401);
      expect(response.body.error.code).toBe('UNAUTHENTICATED');
    });
  });

  describe('rate limiting', () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await createTestApp();
    });
    afterAll(async () => {
      await app?.close();
    });

    const http = () => request(app.getHttpServer());

    it('counts credential attempts per email address, not per caller', async () => {
      // The distinction is the whole point. Every request reaches this API from the
      // frontend's BFF, so one shared address means an IP-keyed limit would lock out all
      // users at once while an attacker spreading guesses over many accounts stays under it.
      //
      // Mutation: drop the email branch from ApiThrottlerGuard.getTracker -> the second
      // account is refused too, because both share the caller's address.
      // Both halves hit the same handler on purpose: the throttler's key includes the
      // handler, so comparing across two different endpoints would pass with any tracker
      // and pin nothing.
      const target = 'locked-out@example.com';

      const attempts = await Promise.all(
        Array.from({ length: 12 }, () =>
          http().post('/auth/login').send({ email: target, password: 'wrong' }),
        ),
      );
      expect(attempts.some((response) => response.status === 429)).toBe(true);

      // Same endpoint, same caller, different address: must still be answered on its merits.
      const other = await http()
        .post('/auth/login')
        .send({ email: 'unaffected@example.com', password: 'whatever' });
      expect(other.status).toBe(401);
      expect(other.body.error.code).toBe('INVALID_CREDENTIALS');
    });
  });

  describe('with no grace window', () => {
    let app: INestApplication;

    beforeAll(async () => {
      // Zero grace makes the reuse rule observable without sleeping in the test.
      app = await createTestApp({ refreshRotationGraceSeconds: 0 });
    });
    afterAll(async () => {
      await app?.close();
    });

    const http = () => request(app.getHttpServer());

    it('treats a replayed token as theft and ends every session', async () => {
      // Mutation: drop revokeAllForUser from the reuse branch -> the second assertion
      // fails, and a stolen token would keep working alongside the legitimate one.
      const session = await http().post('/auth/register').send(credentials).expect(201);
      const original = session.body.refreshToken;

      const rotated = await http().post('/auth/refresh').send({ refreshToken: original }).expect(200);

      const replay = await http().post('/auth/refresh').send({ refreshToken: original }).expect(401);
      expect(replay.body.error.code).toBe('UNAUTHENTICATED');

      // The token issued by the legitimate rotation is revoked as well: once a replay is
      // seen, which copy is the attacker's is unknowable.
      await http().post('/auth/refresh').send({ refreshToken: rotated.body.refreshToken }).expect(401);

      const user = await prisma.user.findUniqueOrThrow({ where: { email: 'dana@acme.com' } });
      expect(await prisma.refreshToken.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
    });
  });
});
