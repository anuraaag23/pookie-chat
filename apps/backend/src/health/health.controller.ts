import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', service: 'pookie-chat-backend', database: 'connected' };
    } catch (error) {
      return {
        status: 'degraded',
        service: 'pookie-chat-backend',
        database: 'disconnected',
        error: error instanceof Error ? error.message : 'Unknown database error',
      };
    }
  }
}
