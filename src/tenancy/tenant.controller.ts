import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PlanLimitsService } from './plan-limits.service';
import { RequirePermissions } from '../auth/permissions.decorator';

@ApiTags('tenant')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('tenant')
export class TenantController {
  constructor(private planLimits: PlanLimitsService) {}

  @Get('usage')
  @RequirePermissions('tenant.manage')
  @ApiOperation({ summary: 'Plan, límites y uso actual de la empresa' })
  usage() {
    return this.planLimits.usage();
  }
}
