import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { PickingStrategy, Prisma } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PlanLimitsService } from './plan-limits.service';
import { RequirePermissions } from '../auth/permissions.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from './tenant-context';
import { tenantPickingStrategy } from '../stock/lot-stock';

class UpdateTenantSettingsDto {
  @ApiPropertyOptional({ enum: PickingStrategy, description: 'Default order in which lots leave the warehouse' })
  @IsOptional()
  @IsEnum(PickingStrategy)
  pickingStrategy?: PickingStrategy;
}

@ApiTags('tenant')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('tenant')
export class TenantController {
  constructor(
    private planLimits: PlanLimitsService,
    private prisma: PrismaService,
  ) {}

  @Get('usage')
  @RequirePermissions('tenant.manage')
  @ApiOperation({ summary: 'Plan, límites y uso actual de la empresa' })
  usage() {
    return this.planLimits.usage();
  }

  @Get('settings')
  @ApiOperation({ summary: 'Preferencias operativas de la empresa' })
  async settings() {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: requireTenantId() } });
    return { pickingStrategy: tenantPickingStrategy(tenant.settings) };
  }

  @Patch('settings')
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'Cambiar las preferencias operativas (estrategia de salida de lotes)' })
  async updateSettings(@Body() dto: UpdateTenantSettingsDto) {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: requireTenantId() } });
    const settings = { ...((tenant.settings ?? {}) as Prisma.JsonObject), ...dto };
    const updated = await this.prisma.tenant.update({ where: { id: tenant.id }, data: { settings } });
    return { pickingStrategy: tenantPickingStrategy(updated.settings) };
  }
}
