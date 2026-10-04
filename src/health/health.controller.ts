import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('health')
@SkipThrottle()
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
    schema: { example: { error: 'SERVICE_UNAVAILABLE', message: 'Base de datos no disponible', details: { database: 'unreachable' } } },
  })
  async check() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException({
        error: 'SERVICE_UNAVAILABLE',
        message: 'Base de datos no disponible',
        details: { database: 'unreachable' },
      });
    }

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: 'ok',
    };
  }
}
