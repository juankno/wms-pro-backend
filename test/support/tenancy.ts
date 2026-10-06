import { randomUUID } from 'crypto';
import { createPrismaClient, PrismaService } from '../../src/prisma/prisma.service';
import { runInTenant } from '../../src/tenancy/tenant-context';

export function testPrisma(): PrismaService {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL must point to a disposable database');
  return createPrismaClient(url);
}

export function createTestTenant(prisma: PrismaService) {
  const suffix = randomUUID().slice(0, 8);
  return prisma.tenant.create({ data: { slug: `t-${suffix}`, name: `Tenant ${suffix}` } });
}

// Deletes every row of the tenant; children cascade from their orders.
export async function deleteTestTenant(prisma: PrismaService, tenantId: string) {
  await prisma.$transaction([
    prisma.activityLog.deleteMany({ where: { tenantId } }),
    prisma.auditLog.deleteMany({ where: { tenantId } }),
    prisma.packingOrder.deleteMany({ where: { tenantId } }),
    prisma.pickingOrder.deleteMany({ where: { tenantId } }),
    prisma.stockMovement.deleteMany({ where: { tenantId } }),
    prisma.locationStock.deleteMany({ where: { tenantId } }),
    prisma.warehouseStock.deleteMany({ where: { tenantId } }),
    prisma.productBarcode.deleteMany({ where: { tenantId } }),
    prisma.product.deleteMany({ where: { tenantId } }),
    prisma.partner.deleteMany({ where: { tenantId } }),
    prisma.userInvitation.deleteMany({ where: { tenantId } }),
    prisma.user.deleteMany({ where: { tenantId } }),
    prisma.tenantRole.deleteMany({ where: { tenantId } }),
    prisma.location.deleteMany({ where: { tenantId } }),
    prisma.warehouse.deleteMany({ where: { tenantId } }),
    prisma.tenant.delete({ where: { id: tenantId } }),
  ]);
}

export { runInTenant };

// Runs every method of `service` inside the tenant returned by `tenantId` (resolved per call).
export function scopedTo<T extends object>(service: T, tenantId: () => string): T {
  return new Proxy(service, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => runInTenant(tenantId(), () => (value as (...a: unknown[]) => unknown).apply(target, args));
    },
  });
}
