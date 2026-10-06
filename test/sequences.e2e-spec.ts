import { Role } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { effectivePermissions } from '../src/auth/permissions';
import { AuthUser } from '../src/common/types/request-with-user.interface';
import { PurchaseOrdersService } from '../src/purchases/purchase-orders.service';
import { formatReference } from '../src/sequences/sequence';
import { SequencesController } from '../src/sequences/sequences.controller';
import { createTestTenant, deleteTestTenant, scopedTo, testPrisma } from './support/tenancy';

describe('Document sequences (integration)', () => {
  const prisma = testPrisma();
  let tenantId: string;
  let otherTenantId: string;
  let admin: AuthUser;
  let otherAdmin: AuthUser;
  const orders = scopedTo(new PurchaseOrdersService(prisma), () => tenantId);
  const otherOrders = scopedTo(new PurchaseOrdersService(prisma), () => otherTenantId);
  const sequences = scopedTo(new SequencesController(prisma), () => tenantId);
  const fixtures = new Map<string, { warehouseId: string; supplierId: string; productId: string }>();

  const order = (forTenant: string, user: AuthUser, reference?: string) => {
    const { warehouseId, supplierId, productId } = fixtures.get(forTenant)!;
    const service = forTenant === tenantId ? orders : otherOrders;
    return service.create({ reference, supplierId, warehouseId, items: [{ productId, quantity: 1 }] }, user);
  };

  beforeAll(async () => {
    [tenantId, otherTenantId] = (await Promise.all([createTestTenant(prisma), createTestTenant(prisma)])).map((t) => t.id);
    for (const id of [tenantId, otherTenantId]) {
      const [warehouse, supplier, product, user] = await Promise.all([
        prisma.warehouse.create({ data: { tenantId: id, code: 'W', name: 'W' } }),
        prisma.partner.create({ data: { tenantId: id, code: 'S', name: 'S', isSupplier: true } }),
        prisma.product.create({ data: { tenantId: id, code: 'P', name: 'P', category: 'c' } }),
        prisma.user.create({ data: { tenantId: id, username: 'a', email: 'a@seq.test', name: 'A', password: 'x', role: Role.admin } }),
      ]);
      fixtures.set(id, { warehouseId: warehouse.id, supplierId: supplier.id, productId: product.id });
      const authUser: AuthUser = {
        id: user.id, sub: user.id, tenantId: id, username: 'a', name: 'A', role: Role.admin, warehouseId: null,
        permissions: effectivePermissions(Role.admin),
      };
      if (id === tenantId) admin = authUser;
      else otherAdmin = authUser;
    }
  });

  afterAll(async () => {
    await deleteTestTenant(prisma, tenantId);
    await deleteTestTenant(prisma, otherTenantId);
    await prisma.$disconnect();
  });

  it('formats references with the configured padding', () => {
    expect(formatReference('OC', 7, 5)).toBe('OC-00007');
    expect(formatReference('PED', 123456, 3)).toBe('PED-123456');
  });

  it('hands out unique consecutive references under concurrency, per tenant', async () => {
    const created = await Promise.all(Array.from({ length: 8 }, () => order(tenantId, admin)));
    expect(created.map((o) => o.reference).sort()).toEqual(Array.from({ length: 8 }, (_, i) => formatReference('OC', i + 1, 5)));
    expect((await order(otherTenantId, otherAdmin)).reference).toBe('OC-00001');
  });

  it('skips references typed by hand and follows prefix changes', async () => {
    await order(tenantId, admin, 'OC-00009');
    expect((await order(tenantId, admin)).reference).toBe('OC-00010');

    const updated = await sequences.update('purchase', { prefix: 'PED', padding: 3, nextValue: 50 });
    expect(updated.preview).toBe('PED-050');
    expect((await order(tenantId, admin)).reference).toBe('PED-050');
    expect((await sequences.findAll()).find((s) => s.key === 'picking')).toMatchObject({ prefix: 'PK', preview: 'PK-00001' });
  });
});
