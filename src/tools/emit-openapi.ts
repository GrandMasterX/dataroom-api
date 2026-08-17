import 'dotenv/config';

import { writeFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from '../app.module';

/**
 * Writes `openapi.json` without starting a server: `pnpm openapi:emit`.
 *
 * Lives under src/ and runs from the build rather than from source through tsx. esbuild —
 * which tsx uses — cannot emit decorator metadata, so Nest sees every constructor parameter
 * type as undefined and refuses to resolve dependencies. Compiled output has the metadata,
 * which is also why the application and the tests were unaffected.
 *
 * The frontend lives in a separate repository and generates its request and response types
 * from this document, so the document is the contract between them. Committing it makes the
 * contract reviewable in a diff — a breaking change shows up as a change to this file rather
 * than as a runtime surprise on the other side.
 */
async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Data Room API')
      .setDescription('Secure document repository for due diligence.')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build(),
  );

  writeFileSync('openapi.json', `${JSON.stringify(document, null, 2)}\n`);
  await app.close();

  const paths = Object.keys(document.paths ?? {}).length;
  console.log(`Wrote openapi.json (${paths} paths).`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
