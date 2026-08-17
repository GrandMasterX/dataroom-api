import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';

class HealthResponse {
  status!: 'ok' | 'degraded';
  database!: 'ok' | 'unreachable';
}

@ApiTags('health')
@Controller('healthz')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Checks the database, not just process liveness. A platform health check that only
   * proves the process is up reports green while every request 500s.
   */
  @Get()
  @ApiOkResponse({ type: HealthResponse })
  async check(): Promise<HealthResponse> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', database: 'ok' };
    } catch {
      return { status: 'degraded', database: 'unreachable' };
    }
  }
}
