import 'dotenv/config';

import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { APP_CONFIG, type AppConfig } from './config/app-config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get<AppConfig>(APP_CONFIG);

  app.use(helmet());
  app.enableCors({ origin: config.corsOrigins, credentials: true });

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      // Unknown fields are rejected rather than stripped silently: a client that
      // believes it set `role: "EDITOR"` must not get a 200 while the server ignored it.
      forbidNonWhitelisted: true,
    }),
  );

  // The OpenAPI document is the contract consumed by the separate frontend repository,
  // which generates its request/response types from it. Reviewers also get a browsable
  // API without running the frontend.
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Data Room API')
      .setDescription('Secure document repository for due diligence.')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build(),
  );
  SwaggerModule.setup('api/docs', app, document, {
    jsonDocumentUrl: 'api/docs-json',
  });

  await app.listen(config.port);
  new Logger('Bootstrap').log(
    `API listening on http://localhost:${config.port} (docs: /api/docs)`,
  );
}

void bootstrap();
