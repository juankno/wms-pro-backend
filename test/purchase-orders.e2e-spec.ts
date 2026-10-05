import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PurchaseOrderStatus, Role } from '@prisma/client';
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { effectivePermissions } from '../src/auth/permissions';
import { AuthUser } from '../src/common/types/request-with-user.interface';
import { PurchaseOrdersService } from '../src/purchases/purchase-orders.service';
import { createTestTenant, deleteTestTenant, scopedTo, testPrisma } from './support/tenancy';

describe('Purchase orders (integration)', () => {
  const prisma = testPrisma();
  let tenantId: string;
  let admin: AuthUser;
  let warehouseId: string;
  let otherWarehouseId: string;
  let supplierId: string;
  let customerOnlyId: string;
  let productIds: string[];
  const orders = scopedTo(new PurchaseOrdersService(prisma), () => tenantId);

  const newOrder = (overrides: Partial<Parameters<typeof orders.create>[0]> = {}) =>
    orders.create(
      {
        reference: `OC-${randomUUID().slice(0, 6)}`,
        supplierId,
        warehouseId,
        items: [{ productId: productIds[0], quantity: 10 }],
        ...overrides,
      },
      admin,
    );

  beforeAll(async () => {
    tenantId = (await createTestTenant(prisma)).id;
    const [main, other] = await Promise.all([
      prisma.warehouse.create({ data: { tenantId, code: 'MAIN', name: 'Main' } }),
      prisma.warehouse.create({ data: { tenantId, code: 'OTHER', name: 'Other' } }),
    ]);
    warehouseId = main.id;
    otherWarehouseId = other.id;
    const user = await prisma.user.create({
      data: { tenantId, username: 'admin', email: 'a@po.test', name: 'Admin', password: 'x', role: Role.admin },
    });
    admin = {
      id: user.id, sub: user.id, tenantId, username: 'admin', name: 'Admin',
      role: Role.admin, warehouseId: null, permissions: effectivePermissions(Role.admin),
    };
    const [supplier, customer] = await Promise.all([
      prisma.partner.create({ data: { tenantId, code: 'SUP', name: 'Proveedor', isSupplier: true } }),
      prisma.partner.create({ data: { tenantId, code: 'CLI', name: 'Cliente', isCustomer: true } }),
    ]);
    supplierId = supplier.id;
    customerOnlyId = customer.id;
    productIds = (
      await Promise.all(
        ['P1', 'P2'].map((code) => prisma.product.create({ data: { tenantId, code, name: code, category: 'c' } })),
      )
    ).map((product) => product.id);
  });

  afterAll(async () => {
    await deleteTestTenant(prisma, tenantId);
    await prisma.$disconnect();
  });

  it('creates an open order with its items', async () => {
    const order = await newOrder({ expectedAt: '2026-11-01', items: productIds.map((productId) => ({ productId, quantity: 5 })) });
    expect(order).toMatchObject({ status: PurchaseOrderStatus.open, supplier: { code: 'SUP' }, warehouse: { code: 'MAIN' } });
    expect(order.items.map((item) => [item.product.code, item.quantity, item.receivedQuantity])).toEqual(
      expect.arrayContaining([['P1', 5, 0], ['P2', 5, 0]]),
    );
  });

  it('validates supplier, products and duplicates', async () => {
    await expect(newOrder({ supplierId: customerOnlyId })).rejects.toMatchObject({ response: { error: 'SUPPLIER_NOT_FOUND' } });
    await expect(
      newOrder({ items: [{ productId: productIds[0], quantity: 1 }, { productId: productIds[0], quantity: 2 }] }),
    ).rejects.toMatchObject({ response: { error: 'DUPLICATE_PRODUCT' } });
    await expect(newOrder({ items: [{ productId: randomUUID(), quantity: 1 }] })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('replaces items before receiving and refuses it afterwards', async () => {
    const order = await newOrder();
    const updated = await orders.update(order.id, { notes: 'Urgente', items: [{ productId: productIds[1], quantity: 3 }] }, admin);
    expect(updated.items.map((item) => item.product.code)).toEqual(['P2']);
    expect(updated.notes).toBe('Urgente');

    await prisma.purchaseOrderItem.updateMany({ where: { purchaseOrderId: order.id }, data: { receivedQuantity: 1 } });
    await expect(orders.update(order.id, { items: [{ productId: productIds[0], quantity: 1 }] }, admin)).rejects.toMatchObject({
      response: { error: 'PURCHASE_ORDER_RECEIVING' },
    });
  });

  it('cancels open orders and closes partially received ones', async () => {
    const open = await newOrder();
    await expect(orders.close(open.id, admin)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect((await orders.cancel(open.id, admin)).status).toBe(PurchaseOrderStatus.cancelled);
    await expect(orders.update(open.id, { notes: 'x' }, admin)).rejects.toBeInstanceOf(UnprocessableEntityException);

    const partial = await newOrder();
    await prisma.purchaseOrder.update({ where: { id: partial.id }, data: { status: PurchaseOrderStatus.partially_received } });
    expect((await orders.close(partial.id, admin)).status).toBe(PurchaseOrderStatus.closed);
  });

  it('keeps users to their warehouse', async () => {
    const supervisor: AuthUser = { ...admin, role: Role.supervisor, warehouseId: otherWarehouseId, permissions: effectivePermissions(Role.supervisor) };
    const order = await newOrder();
    await expect(orders.findById(order.id, supervisor)).rejects.toMatchObject({ response: { error: 'WAREHOUSE_FORBIDDEN' } });
    const listed = await orders.findAll({ warehouseId: otherWarehouseId, page: 1, limit: 50 });
    expect(listed.data.map((o) => o.id)).not.toContain(order.id);
  });
});
