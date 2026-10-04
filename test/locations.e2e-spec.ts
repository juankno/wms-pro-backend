import { ConflictException, ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { LocationType, Role, Tenant, Warehouse } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { effectivePermissions } from '../src/auth/permissions';
import { AuthUser } from '../src/common/types/request-with-user.interface';
import { LocationsService } from '../src/locations/locations.service';
import { createTestTenant, deleteTestTenant, scopedTo, testPrisma } from './support/tenancy';

describe('Locations (integration)', () => {
  const prisma = testPrisma();
  let tenant: Tenant;
  let other: Tenant;
  let warehouse: Warehouse;
  let foreignWarehouse: Warehouse;
  let admin: AuthUser;
  const locations = scopedTo(new LocationsService(prisma), () => tenant.id);
  const otherLocations = scopedTo(new LocationsService(prisma), () => other.id);

  const userOf = (tenantId: string, role: Role, warehouseId: string | null): AuthUser => ({
    id: 'u', sub: 'u', tenantId, username: 'u', name: 'U', role, warehouseId, permissions: effectivePermissions(role),
  });

  beforeAll(async () => {
    [tenant, other] = await Promise.all([createTestTenant(prisma), createTestTenant(prisma)]);
    [warehouse, foreignWarehouse] = await Promise.all([
      prisma.warehouse.create({ data: { tenantId: tenant.id, name: 'Main', code: 'MAIN' } }),
      prisma.warehouse.create({ data: { tenantId: other.id, name: 'Other', code: 'OTHER' } }),
    ]);
    admin = userOf(tenant.id, Role.admin, null);
  });

  afterAll(async () => {
    await deleteTestTenant(prisma, tenant.id);
    await deleteTestTenant(prisma, other.id);
    await prisma.$disconnect();
  });

  it('generates a hierarchy once and keeps existing codes on a second run', async () => {
    const levels = [
      { type: LocationType.aisle, start: 'A', count: 2 },
      { type: LocationType.rack, start: '01', count: 3 },
      { type: LocationType.bin, start: '1', count: 2 },
    ];

    expect(await locations.generate({ warehouseId: warehouse.id, levels }, admin)).toEqual({ created: 20, skipped: 0 });
    expect(await locations.generate({ warehouseId: warehouse.id, levels }, admin)).toEqual({ created: 0, skipped: 20 });

    const bin = await prisma.location.findUniqueOrThrow({ where: { warehouseId_code: { warehouseId: warehouse.id, code: 'B-03-2' } } });
    expect(bin).toMatchObject({ type: LocationType.bin, storable: true });
    const detail = await locations.findById(bin.id, admin);
    expect(detail.path.map((node) => node.code)).toEqual(['B', 'B-03']);

    const roots = await locations.findAll({ warehouseId: warehouse.id, parentId: 'root', page: 1, limit: 20 });
    expect(roots.data.map((l) => [l.code, l.storable, l._count.children])).toEqual([
      ['A', false, 3],
      ['B', false, 3],
    ]);
  });

  it('creates locations with uppercase codes under a parent of the same warehouse', async () => {
    const zone = await locations.create({ warehouseId: warehouse.id, code: 'rec', type: LocationType.dock }, admin);
    expect(zone).toMatchObject({ code: 'REC', storable: true });

    const foreignParent = await otherLocations.create(
      { warehouseId: foreignWarehouse.id, code: 'X', type: LocationType.zone },
      userOf(other.id, Role.admin, null),
    );
    await expect(
      locations.create({ warehouseId: warehouse.id, parentId: foreignParent.id, code: 'Y', type: LocationType.bin }, admin),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses moves that create cycles and deletes only leaves', async () => {
    const aisle = await prisma.location.findUniqueOrThrow({ where: { warehouseId_code: { warehouseId: warehouse.id, code: 'A' } } });
    const rack = await prisma.location.findUniqueOrThrow({ where: { warehouseId_code: { warehouseId: warehouse.id, code: 'A-01' } } });

    await expect(locations.update(aisle.id, { parentId: rack.id }, admin)).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(locations.delete(rack.id, admin)).rejects.toBeInstanceOf(ConflictException);

    const leaf = await prisma.location.findUniqueOrThrow({ where: { warehouseId_code: { warehouseId: warehouse.id, code: 'A-01-1' } } });
    await locations.delete(leaf.id, admin);
    expect(await prisma.location.findUnique({ where: { id: leaf.id } })).toBeNull();
  });

  it('limits users to their warehouse', async () => {
    const outsider = userOf(tenant.id, Role.supervisor, null);
    await expect(
      locations.create({ warehouseId: warehouse.id, code: 'Q', type: LocationType.bin }, outsider),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects generations above the limit', async () => {
    const levels = [
      { type: LocationType.aisle, start: '1', count: 100 },
      { type: LocationType.rack, start: '1', count: 100 },
    ];
    await expect(locations.generate({ warehouseId: warehouse.id, levels }, admin)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });
});
