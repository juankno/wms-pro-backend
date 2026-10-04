import { ForbiddenException } from '@nestjs/common';
import { Tenant } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlanLimitsService } from '../src/tenancy/plan-limits.service';
import { WarehousesService } from '../src/warehouses/warehouses.service';
import { createTestTenant, deleteTestTenant, scopedTo, testPrisma } from './support/tenancy';

describe('Plan limits (integration)', () => {
  const prisma = testPrisma();
  let tenant: Tenant;
  const limits = scopedTo(new PlanLimitsService(prisma), () => tenant.id);
  const warehouses = scopedTo(new WarehousesService(prisma, new PlanLimitsService(prisma)), () => tenant.id);

  beforeAll(async () => {
    tenant = await createTestTenant(prisma);
  });

  afterAll(async () => {
    await deleteTestTenant(prisma, tenant.id);
    await prisma.$disconnect();
  });

  it('reports the plan, its limits and the current usage', async () => {
    const report = await limits.usage();

    expect(report).toMatchObject({
      plan: 'trial',
      limits: { users: 5, warehouses: 1, ordersPerMonth: 300 },
      usage: { users: 0, warehouses: 0, ordersPerMonth: 0 },
    });
  });

  it('blocks creating beyond the plan limit', async () => {
    await warehouses.create({ name: 'Main', code: 'MAIN' });

    await expect(warehouses.create({ name: 'Second', code: 'SECOND' })).rejects.toMatchObject({
      response: { error: 'PLAN_LIMIT_REACHED', details: { resource: 'warehouses', limit: 1, used: 1 } },
    });
    await expect(warehouses.create({ name: 'Second', code: 'SECOND' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('honors per-tenant overrides from settings', async () => {
    await prisma.tenant.update({ where: { id: tenant.id }, data: { settings: { limits: { warehouses: 2 } } } });

    await expect(warehouses.create({ name: 'Second', code: 'SECOND' })).resolves.toMatchObject({ code: 'SECOND' });
  });
});
