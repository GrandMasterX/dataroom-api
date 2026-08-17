/**
 * Integration tests: real PostgreSQL, real MinIO, no mocks.
 *
 * Half of these exist specifically to prove that the *database* enforces something —
 * a unique index, a CHECK, a trigger, a cascade. A mocked Prisma client cannot prove any
 * of that, so those tests would be theatre.
 *
 * Run serially: they truncate shared tables between cases.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/test'],
  testRegex: '\\.int-spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  setupFilesAfterEnv: ['<rootDir>/test/int/setup.ts'],
  maxWorkers: 1,
  testTimeout: 30_000,
};
