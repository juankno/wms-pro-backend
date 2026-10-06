import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActivityService } from '../src/activity/activity.service';
import { effectivePermissions } from '../src/auth/permissions';
import { AuthUser } from '../src/common/types/request-with-user.interface';
import { PartnersService } from '../src/partners/partners.service';
import { PickingService } from '../src/picking/picking.service';
import { PlanLimitsService } from '../src/tenancy/plan-limits.service';
import { UploadsService } from '../src/uploads/uploads.service';
import { createTestTenant, deleteTestTenant, scopedTo, testPrisma } from './support/tenancy';

describe('Partners (integration)', () => {
  const prisma = testPrisma();
  let tenantId: string;
  let otherTenantId: string;
  let admin: AuthUser;
  let warehouseId: string;
  let productId: string;
  const partners = scopedTo(new PartnersService(prisma), () => tenantId);
  const otherPartners = scopedTo(new PartnersService(prisma), () => otherTenantId);
  const uploads = { deleteFile: () => undefined } as unknown as UploadsService;
  const picking = scopedTo(
    new PickingService(prisma, new ActivityService(prisma), uploads, new PlanLimitsService(prisma)),
    () => tenantId,
  );

  beforeAll(async () => {
    [tenantId, otherTenantId] = (await Promise.all([createTestTenant(prisma), createTestTenant(prisma)])).map((t) => t.id);
    const warehouse = await prisma.warehouse.create({ data: { tenantId, code: 'W', name: 'W' } });
    warehouseId = warehouse.id;
    const user = await prisma.user.create({
      data: { tenantId, username: 'admin', email: 'a@p.test', name: 'Admin', password: 'x', role: Role.admin, warehouseId },
    });
    admin = {
      id: user.id, sub: user.id, tenantId, username: 'admin', name: 'Admin',
      role: Role.admin, warehouseId, permissions: effectivePermissions(Role.admin),
    };
    const product = await prisma.product.create({ data: { tenantId, code: 'P1', name: 'P1', category: 'c' } });
    productId = product.id;
    await prisma.warehouseStock.create({ data: { tenantId, productId, warehouseId, onHand: 10 } });
  });

  afterAll(async () => {
    await deleteTestTenant(prisma, tenantId);
    await deleteTestTenant(prisma, otherTenantId);
    await prisma.$disconnect();
  });

  it('filters customers and suppliers and hides inactive ones by default', async () => {
    const acme = await partners.create({ code: 'acme', name: 'Acme', isCustomer: true, isSupplier: true });
    await partners.create({ code: 'SUP-1', name: 'Proveedor Uno', isSupplier: true });
    const gone = await partners.create({ code: 'OLD', name: 'Antiguo', isCustomer: true });
    await partners.update(gone.id, { active: false });

    expect(acme.code).toBe('ACME');
    const names = async (query: Parameters<typeof partners.findAll>[0]) =>
      (await partners.findAll(query)).data.map((p) => p.name);
    expect(await names({ kind: 'customer', page: 1, limit: 20 })).toEqual(['Acme']);
    expect(await names({ kind: 'supplier', page: 1, limit: 20 })).toEqual(['Acme', 'Proveedor Uno']);
    expect(await names({ kind: 'customer', includeInactive: true, page: 1, limit: 20 })).toEqual(['Acme', 'Antiguo']);
  });

  it('requires at least one kind', async () => {
    await expect(partners.create({ code: 'NONE', name: 'Nadie' })).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('links picking orders to active customers of the same tenant', async () => {
    const customer = await partners.create({ code: 'C-1', name: 'Cliente Uno', isCustomer: true });
    const supplier = await partners.create({ code: 'S-2', name: 'Solo proveedor', isSupplier: true });
    const foreign = await otherPartners.create({ code: 'F-1', name: 'Ajeno', isCustomer: true });
    const items = [{ productId, quantity: 1 }];

    const order = await picking.create({ reference: 'R-1', customerId: customer.id, warehouseId, items }, admin);
    expect(order).toMatchObject({ client: 'Cliente Uno', customerId: customer.id });

    for (const customerId of [supplier.id, foreign.id]) {
      await expect(picking.create({ reference: `R-${customerId}`, customerId, warehouseId, items }, admin)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    }
    await expect(picking.create({ reference: 'R-2', warehouseId, items }, admin)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });
});
