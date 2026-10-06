import { NotFoundException } from '@nestjs/common';
import { Role, Tenant } from '@prisma/client';
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActivityService } from '../src/activity/activity.service';
import { AuthUser } from '../src/common/types/request-with-user.interface';
import { PickingService } from '../src/picking/picking.service';
import { ProductsService } from '../src/products/products.service';
import { ReportsService } from '../src/reports/reports.service';
import { UploadsService } from '../src/uploads/uploads.service';
import { WarehousesService } from '../src/warehouses/warehouses.service';
import { createTestTenant, deleteTestTenant, runInTenant, scopedTo, testPrisma } from './support/tenancy';

interface TenantFixture {
  tenant: Tenant;
  admin: AuthUser;
  warehouseId: string;
  productId: string;
}

describe('Tenant isolation (integration)', () => {
  const prisma = testPrisma();
  const uploads = {} as UploadsService;
  let a: TenantFixture;
  let b: TenantFixture;

  const servicesFor = (fixture: () => TenantFixture) => {
    const tenantId = () => fixture().tenant.id;
    return {
      products: scopedTo(new ProductsService(prisma, uploads), tenantId),
      warehouses: scopedTo(new WarehousesService(prisma), tenantId),
      reports: scopedTo(new ReportsService(prisma), tenantId),
      picking: scopedTo(new PickingService(prisma, new ActivityService(prisma), uploads), tenantId),
    };
  };
  const asA = servicesFor(() => a);

  const seedTenant = async (): Promise<TenantFixture> => {
    const tenant = await createTestTenant(prisma);
    const suffix = randomUUID().slice(0, 8);
    const warehouse = await prisma.warehouse.create({ data: { tenantId: tenant.id, code: 'MAIN', name: `Main ${suffix}` } });
    const product = await prisma.product.create({
      data: { tenantId: tenant.id, code: 'SHARED-CODE', name: `Product ${suffix}`, category: 'shared', barcode: '7700000000001' },
    });
    await prisma.warehouseStock.create({
      data: { tenantId: tenant.id, productId: product.id, warehouseId: warehouse.id, onHand: 10 },
    });
    const user = await prisma.user.create({
      data: { tenantId: tenant.id, username: 'admin', email: 'admin@example.com', name: 'Admin', password: 'unused', role: Role.admin },
    });
    return {
      tenant,
      warehouseId: warehouse.id,
      productId: product.id,
      admin: { id: user.id, sub: user.id, tenantId: tenant.id, username: 'admin', name: 'Admin', role: Role.admin, warehouseId: null },
    };
  };

  beforeAll(async () => {
    [a, b] = await Promise.all([seedTenant(), seedTenant()]);
  });

  afterAll(async () => {
    await deleteTestTenant(prisma, a.tenant.id);
    await deleteTestTenant(prisma, b.tenant.id);
    await prisma.$disconnect();
  });

  it('allows the same codes and barcodes in different tenants', async () => {
    const shared = await prisma.product.count({ where: { code: 'SHARED-CODE', tenantId: { in: [a.tenant.id, b.tenant.id] } } });

    expect(shared).toBe(2);
  });

  it('lists only the current tenant products and warehouses', async () => {
    const { data } = await asA.products.findAll({ page: 1, limit: 100 }, a.warehouseId);
    const warehouses = await asA.warehouses.findAll();

    expect(data.map((p) => p.id)).toEqual([a.productId]);
    expect(warehouses.map((w) => w.id)).toEqual([a.warehouseId]);
  });

  it('does not find or modify records of another tenant', async () => {
    await expect(asA.products.findById(b.productId, undefined)).rejects.toBeInstanceOf(NotFoundException);
    await expect(asA.products.update(b.productId, { name: 'Hijacked' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(asA.warehouses.findById(b.warehouseId)).rejects.toBeInstanceOf(NotFoundException);

    const untouched = await prisma.product.findUniqueOrThrow({ where: { id: b.productId } });
    expect(untouched.name).not.toBe('Hijacked');
  });

  it('cannot reserve stock of another tenant from an order', async () => {
    await expect(
      asA.picking.create(
        { reference: `X-${randomUUID().slice(0, 6)}`, client: 'C', warehouseId: b.warehouseId, items: [{ productId: b.productId, quantity: 1 }] },
        a.admin,
      ),
    ).rejects.toThrow();

    const stockB = await prisma.warehouseStock.findFirstOrThrow({ where: { tenantId: b.tenant.id } });
    expect(stockB.reserved).toBe(0);
  });

  it('stamps records created inside interactive transactions with the current tenant', async () => {
    const order = await asA.picking.create(
      { reference: `PK-${randomUUID().slice(0, 6)}`, client: 'C', warehouseId: a.warehouseId, items: [{ productId: a.productId, quantity: 2 }] },
      a.admin,
    );

    const stored = await prisma.pickingOrder.findUniqueOrThrow({ where: { id: order.id } });
    const log = await prisma.activityLog.findFirstOrThrow({ where: { orderId: order.id } });
    expect(stored.tenantId).toBe(a.tenant.id);
    expect(log.tenantId).toBe(a.tenant.id);
  });

  it('aggregates reports over the current tenant only', async () => {
    const report = await asA.reports.getStockStatus();

    expect(report.summary.total).toBe(1);
  });

  it('scopes queries made directly through the client inside a tenant context', async () => {
    const products = await runInTenant(b.tenant.id, () => prisma.product.findMany({ where: { code: 'SHARED-CODE' } }));

    expect(products.map((p) => p.id)).toEqual([b.productId]);
  });

  it('keeps the tenant for queries awaited outside the context or batched with Promise.all', async () => {
    const deferred = runInTenant(b.tenant.id, () => prisma.product.findMany({ where: { code: 'SHARED-CODE' } }));
    const [batched] = await runInTenant(b.tenant.id, () =>
      Promise.all([prisma.product.count({ where: { code: 'SHARED-CODE' } }), prisma.warehouse.count()]),
    );

    expect((await deferred).map((p) => p.id)).toEqual([b.productId]);
    expect(batched).toBe(1);
  });
});
