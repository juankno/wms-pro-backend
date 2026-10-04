import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LimitedResource, resolveLimits } from './plans';
import { requireTenantId } from './tenant-context';

const RESOURCE_LABELS: Record<LimitedResource, string> = {
  users: 'usuarios activos',
  warehouses: 'almacenes activos',
  ordersPerMonth: 'órdenes de picking este mes',
};

function startOfMonth(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

@Injectable()
export class PlanLimitsService {
  constructor(private prisma: PrismaService) {}

  async usage() {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: requireTenantId() } });
    const [users, warehouses, ordersPerMonth] = await Promise.all([
      this.prisma.user.count({ where: { active: true } }),
      this.prisma.warehouse.count({ where: { active: true } }),
      this.prisma.pickingOrder.count({ where: { createdAt: { gte: startOfMonth() } } }),
    ]);
    return {
      plan: tenant.plan,
      limits: resolveLimits(tenant.plan, tenant.settings),
      usage: { users, warehouses, ordersPerMonth },
    };
  }

  // Soft limit: concurrent creations can exceed it by a few units, which is acceptable for billing tiers.
  async assertCanCreate(resource: LimitedResource): Promise<void> {
    const { limits, usage } = await this.usage();
    const limit = limits[resource];
    if (limit !== null && usage[resource] >= limit) {
      throw new ForbiddenException({
        error: 'PLAN_LIMIT_REACHED',
        message: `Tu plan permite ${limit} ${RESOURCE_LABELS[resource]}. Mejora el plan para continuar.`,
        details: { resource, limit, used: usage[resource] },
      });
    }
  }
}
