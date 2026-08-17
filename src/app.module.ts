import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AccessContextGuard } from './auth/access-context.guard';
import { AuthModule } from './auth/auth.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { NodesModule } from './nodes/nodes.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    // In-memory storage is correct for a single instance. A distributed limit would need
    // shared state (Redis); until there are several instances that would be infrastructure
    // for its own sake.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    AuthModule,
    NodesModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Runs on every request and populates the AccessContext. It does not reject
    // unauthenticated requests: read endpoints are also reachable with a share token, and
    // endpoints that need a real user say so with @RequireUser().
    { provide: APP_GUARD, useClass: AccessContextGuard },
  ],
})
export class AppModule {}
