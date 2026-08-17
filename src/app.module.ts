import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AccessContextGuard } from './auth/access-context.guard';
import { AuthModule } from './auth/auth.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ApiThrottlerGuard } from './common/guards/api-throttler.guard';
import { APP_CONFIG, type AppConfig } from './config/app-config';
import { ConfigModule } from './config/config.module';
import { DataRoomsModule } from './data-rooms/data-rooms.module';
import { HealthModule } from './health/health.module';
import { NodesModule } from './nodes/nodes.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    // In-memory storage is correct for a single instance. A distributed limit would need
    // shared state (Redis); with one instance that would be infrastructure for its own sake.
    ThrottlerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        // A single global throttler. Named throttlers all apply to every route unless
        // explicitly skipped, so adding a strict "auth" one here would silently cap every
        // other endpoint at the auth limit.
        throttlers: [
          { ttl: config.throttle.windowSeconds * 1000, limit: config.throttle.limit },
        ],
      }),
    }),
    AuthModule,
    NodesModule,
    DataRoomsModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: ApiThrottlerGuard },
    // Runs on every request and populates the AccessContext. It does not reject
    // unauthenticated requests: read endpoints are also reachable with a share token, and
    // endpoints that need a real user say so with @RequireUser().
    { provide: APP_GUARD, useClass: AccessContextGuard },
  ],
})
export class AppModule {}
