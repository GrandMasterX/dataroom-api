import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { APP_CONFIG, loadAppConfig, type AppConfig } from '../../src/config/app-config';

/**
 * Boots the real application against the test database.
 *
 * Nothing is mocked: these tests exist to check the behaviour of the whole request path —
 * guards, pipes, the exception filter, the database — because that is where the
 * interesting failures live. The only override is the connection string, so a test run
 * cannot touch the development data.
 */
export async function createTestApp(
  configOverrides: Partial<AppConfig> = {},
): Promise<INestApplication> {
  const baseConfig = loadAppConfig();
  const config: AppConfig = {
    ...baseConfig,
    databaseUrl: process.env.TEST_DATABASE_URL as string,
    ...configOverrides,
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(config)
    .compile();

  const app = moduleRef.createNestApplication();
  // Mirrors main.ts. If these diverge, tests stop describing production behaviour.
  app.useGlobalPipes(
    new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
  );
  // `listen`, not just `init`. Supertest binds a server itself when the one it is handed is
  // not listening — and it does that per request, then tears it down. Thousands of ephemeral
  // ports opened and closed in a few seconds is fine on an idle machine and starts producing
  // `read ECONNRESET` when the machine is busy, which surfaces as a random test failing
  // somewhere unrelated. Listening once per suite means supertest reuses this server.
  //
  // Port 0 lets the OS choose, so suites cannot collide with each other or with a dev server.
  await app.listen(0);
  return app;
}
