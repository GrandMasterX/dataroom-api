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
  await app.init();
  return app;
}
