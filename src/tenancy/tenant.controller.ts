import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { PlanLimitsService } from './plan-limits.service';

@ApiTags('tenant')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('tenant')
export class TenantController {
  constructor(private planLimits: PlanLimitsService) {}

  @Get('usage')
  @Roles(Role.admin)
  @ApiOperation({ summary: 'Plan, límites y uso actual de la empresa' })
  usage() {
    return this.planLimits.usage();
  }
}
