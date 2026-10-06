import { OrderStatus, Role, ShipmentStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActivityService } from '../src/activity/activity.service';
import { effectivePermissions } from '../src/auth/permissions';
import { AuthUser } from '../src/common/types/request-with-user.interface';
import { LabelsService } from '../src/labels/labels.service';
import { PackingService } from '../src/packing/packing.service';
import { PickingService } from '../src/picking/picking.service';
import { ShippingService, trackingUrl } from '../src/shipping/shipping.service';
import { PlanLimitsService } from '../src/tenancy/plan-limits.service';
import { UploadsService } from '../src/uploads/uploads.service';
import { createTestTenant, deleteTestTenant, scopedTo, testPrisma } from './support/tenancy';

describe('Shipping (integration)', () => {
  const prisma = testPrisma();
  let tenantId: string;
  const scoped = <T extends object>(service: T) => scopedTo(service, () => tenantId);
  const activity = new ActivityService(prisma);
  const uploads = { deleteFile: () => undefined } as unknown as UploadsService;
  const picking = scoped(new PickingService(prisma, activity, uploads, new PlanLimitsService(prisma)));
  const packing = scoped(new PackingService(prisma, activity, uploads));
  const shipping = scoped(new ShippingService(prisma));
  const labels = scoped(new LabelsService(prisma));

  let admin: AuthUser;
  let warehouseId: string;
  let productId: string;

  const packedOrder = async (complete = true) => {
    const order = await picking.create({ reference: `R-${randomUUID().slice(0, 6)}`, client: 'Tienda Centro', warehouseId, items: [{ productId, quantity: 1 }] }, admin);
    await picking.updateItem(order.id, order.items[0].id, 1, admin);
    await picking.updateStatus(order.id, OrderStatus.in_progress, admin);
    await picking.updateStatus(order.id, OrderStatus.completed, admin);
    const pack = await packing.create({ pickingOrderId: order.id }, admin);
    await packing.addBox(pack.id, { label: 'C1' }, admin);
    await packing.addBox(pack.id, { label: 'C2' }, admin);
    if (complete) {
      await packing.updateItem(pack.id, pack.items[0].id, 1, admin);
      await packing.updateStatus(pack.id, OrderStatus.in_progress, admin);
      await packing.updateStatus(pack.id, OrderStatus.completed, admin);
    }
    return pack;
  };

  beforeAll(async () => {
    tenantId = (await createTestTenant(prisma)).id;
    warehouseId = (await prisma.warehouse.create({ data: { tenantId, code: 'W', name: 'W' } })).id;
    const user = await prisma.user.create({
      data: { tenantId, username: 'admin', email: 'a@ship.test', name: 'Admin', password: 'x', role: Role.admin },
    });
    admin = {
      id: user.id, sub: user.id, tenantId, username: 'admin', name: 'Admin',
      role: Role.admin, warehouseId: null, permissions: effectivePermissions(Role.admin),
    };
    productId = (await prisma.product.create({ data: { tenantId, code: 'P', name: 'P', category: 'c' } })).id;
    await prisma.warehouseStock.create({ data: { tenantId, productId, warehouseId, onHand: 100 } });
  });

  afterAll(async () => {
    await deleteTestTenant(prisma, tenantId);
    await prisma.$disconnect();
  });

  it('builds tracking links from the carrier template', () => {
    expect(trackingUrl('https://t.example/{tracking}', 'G 1/2')).toBe('https://t.example/G%201%2F2');
    expect(trackingUrl(null, 'G1')).toBeNull();
  });

  it('ships a completed packing once and records the delivery', async () => {
    const carrier = await shipping.createCarrier({ name: 'Rápido', trackingUrlTemplate: 'https://rastreo.test/{tracking}' });
    const pack = await packedOrder();

    const shipment = await shipping.ship(pack.id, { carrierId: carrier.id, trackingNumber: ' G-123 ' }, admin);
    expect(shipment).toMatchObject({
      status: ShipmentStatus.shipped,
      carrierName: 'Rápido',
      trackingNumber: 'G-123',
      trackingUrl: 'https://rastreo.test/G-123',
      packingOrder: { client: 'Tienda Centro' },
    });
    await expect(shipping.ship(pack.id, {}, admin)).rejects.toMatchObject({ response: { error: 'ALREADY_SHIPPED' } });

    const delivered = await shipping.deliver(shipment.id, { receivedBy: 'Laura Gómez' }, admin);
    expect(delivered).toMatchObject({ status: ShipmentStatus.delivered, receivedBy: 'Laura Gómez', deliveredAt: expect.any(Date) });
    await expect(shipping.deliver(shipment.id, { receivedBy: 'Otra' }, admin)).rejects.toMatchObject({ response: { error: 'ALREADY_DELIVERED' } });

    const found = await shipping.findAll({ search: 'G-123', page: 1, limit: 10 });
    expect(found.data.map((s) => s.id)).toEqual([shipment.id]);
  });

  it('refuses packings that are not completed and inactive carriers', async () => {
    const pending = await packedOrder(false);
    await expect(shipping.ship(pending.id, {}, admin)).rejects.toMatchObject({ response: { error: 'PACKING_NOT_COMPLETED' } });

    const retired = await shipping.createCarrier({ name: 'Retirada' });
    await shipping.updateCarrier(retired.id, { active: false });
    const pack = await packedOrder();
    await expect(shipping.ship(pack.id, { carrierId: retired.id }, admin)).rejects.toMatchObject({ response: { error: 'CARRIER_NOT_FOUND' } });
    expect((await shipping.carriers()).map((c) => c.name)).not.toContain('Retirada');
  });

  it('prints one shipping label per box with the tracking number', async () => {
    const pack = await packedOrder();
    await shipping.ship(pack.id, { carrierName: 'Propia', trackingNumber: 'T-77' }, admin);
    const result = await labels.packing(pack.id, admin);
    expect(result.map((label) => [label.title, label.barcode])).toEqual([
      ['Tienda Centro', 'T-77'],
      ['Tienda Centro', 'T-77'],
    ]);
  });
});
