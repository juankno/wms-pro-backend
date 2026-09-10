import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private prisma: PrismaService) {}

  @Get()
  @ApiOperation({
    summary: 'Health check',
    description: 'Verifica que el servidor y la base de datos están operativos. Usar para liveness/readiness probes.',
  })
  @ApiResponse({
    status: 200,
    description: 'Servicio operativo',
    schema: {
      example: {
        status: 'ok',
        timestamp: '2025-09-09T12:00:00.000Z',
        uptime: 3600.5,
        database: 'ok',
      },
    },
  })
  @ApiResponse({
    status: 503,
    description: 'Servicio degradado',
    schema: { example: { status: 'error', database: 'unreachable' } },
  })
  async check() {
    let dbStatus = 'ok';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      dbStatus = 'unreachable';
    }

    return {
      status: dbStatus === 'ok' ? 'ok' : 'error',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: dbStatus,
    };
  }
}
