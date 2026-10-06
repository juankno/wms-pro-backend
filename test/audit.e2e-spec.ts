import { Tenant } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service';
import { createTestTenant, deleteTestTenant, scopedTo, testPrisma } from './support/tenancy';

describe('Audit log (integration)', () => {
  const prisma = testPrisma();
  let a: Tenant;
  let b: Tenant;
  const auditA = scopedTo(new AuditService(prisma), () => a.id);

  const entry = (tenant: Tenant, resource: string) => ({
    tenantId: tenant.id,
    actorId: 'actor',
    actorName: 'Actor',
    action: 'update',
    resource,
    resourceId: 'r1',
    route: `PATCH /${resource}/:id`,
    statusCode: 200,
    payload: { name: 'nuevo' },
  });

  beforeAll(async () => {
    [a, b] = await Promise.all([createTestTenant(prisma), createTestTenant(prisma)]);
    const audit = new AuditService(prisma);
    await audit.record(entry(a, 'products'));
    await audit.record(entry(a, 'warehouses'));
    await audit.record(entry(b, 'products'));
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { tenantId: { in: [a.id, b.id] } } });
    await deleteTestTenant(prisma, a.id);
    await deleteTestTenant(prisma, b.id);
    await prisma.$disconnect();
  });

  it('lists only the entries of the current tenant', async () => {
    const { data, meta } = await auditA.findAll({ page: 1, limit: 20 });

    expect(meta.total).toBe(2);
    expect(data.every((log) => log.tenantId === a.id)).toBe(true);
  });

  it('filters by resource and keeps the payload', async () => {
    const { data } = await auditA.findAll({ resource: 'products', page: 1, limit: 20 });

    expect(data).toHaveLength(1);
    expect(data[0].payload).toEqual({ name: 'nuevo' });
  });
});
