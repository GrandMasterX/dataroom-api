/**
 * Unit tests: pure logic only (path arithmetic, name resolution, permission matrix).
 * Anything whose behaviour is a property of PostgreSQL or S3 belongs in the integration
 * suite — a mocked client can only confirm what the author already believed.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/src'],
  testRegex: '\\.spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  clearMocks: true,
};
