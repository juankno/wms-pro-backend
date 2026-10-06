import { Global, Module } from '@nestjs/common';
import { PlanLimitsService } from './plan-limits.service';
import { TenantController } from './tenant.controller';

@Global()
@Module({
  controllers: [TenantController],
  providers: [PlanLimitsService],
  exports: [PlanLimitsService],
})
export class TenancyModule {}
