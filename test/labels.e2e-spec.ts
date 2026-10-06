import { LocationType, Role } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { effectivePermissions } from '../src/auth/permissions';
import { AuthUser } from '../src/common/types/request-with-user.interface';
import { toPdf } from '../src/labels/label-pdf';
import { LabelsService } from '../src/labels/labels.service';
import { createTestTenant, deleteTestTenant, scopedTo, testPrisma } from './support/tenancy';

describe('Labels (integration)', () => {
  const prisma = testPrisma();
  let tenantId: string;
  let admin: AuthUser;
  let warehouseId: string;
  let otherWarehouseId: string;
  let aisleId: string;
  const labels = scopedTo(new LabelsService(prisma), () => tenantId);

  beforeAll(async () => {
    tenantId = (await createTestTenant(prisma)).id;
    const [main, other] = await Promise.all([
      prisma.warehouse.create({ data: { tenantId, code: 'BOG', name: 'Bogotá' } }),
      prisma.warehouse.create({ data: { tenantId, code: 'MED', name: 'Medellín' } }),
    ]);
    warehouseId = main.id;
    otherWarehouseId = other.id;
    admin = {
      id: 'u', sub: 'u', tenantId, username: 'admin', name: 'Admin',
      role: Role.admin, warehouseId: null, permissions: effectivePermissions(Role.admin),
    };
    aisleId = (await prisma.location.create({ data: { tenantId, warehouseId, code: 'A', type: LocationType.aisle, storable: false } })).id;
    await prisma.location.createMany({
      data: [
        { tenantId, warehouseId, parentId: aisleId, code: 'A-2', type: LocationType.bin, pickSequence: 2 },
        { tenantId, warehouseId, parentId: aisleId, code: 'A-1', type: LocationType.bin, pickSequence: 1, name: 'Picking' },
      ],
    });
    await prisma.product.createMany({
      data: [
        { tenantId, code: 'P-2', name: 'Tuerca', category: 'c' },
        { tenantId, code: 'P-1', name: 'Tornillo', category: 'c', barcode: '7701' },
      ],
    });
  });

  afterAll(async () => {
    await deleteTestTenant(prisma, tenantId);
    await prisma.$disconnect();
  });

  it('builds product labels with the barcode or the code', async () => {
    const ids = (await prisma.product.findMany({ where: { tenantId } })).map((p) => p.id);
    expect(await labels.products(ids)).toEqual([
      { title: 'P-1', subtitle: 'Tornillo', barcode: '7701' },
      { title: 'P-2', subtitle: 'Tuerca', barcode: 'P-2' },
    ]);
  });

  it('prints the locations under a parent in walking order', async () => {
    const result = await labels.locations({ warehouseId, parentId: aisleId }, admin);
    expect(result.map((label) => [label.title, label.subtitle])).toEqual([
      ['A-1', 'BOG · Picking'],
      ['A-2', 'BOG'],
    ]);
  });

  it('requires a scope and access to the warehouse', async () => {
    await expect(labels.locations({}, admin)).rejects.toMatchObject({ response: { error: 'LABELS_SCOPE_REQUIRED' } });
    const outsider: AuthUser = { ...admin, role: Role.operator, warehouseId: otherWarehouseId, permissions: effectivePermissions(Role.operator) };
    await expect(labels.locations({ warehouseId }, outsider)).rejects.toMatchObject({ response: { error: 'WAREHOUSE_FORBIDDEN' } });
  });

  it('renders one PDF page per label', async () => {
    const pdf = await toPdf(await labels.locations({ warehouseId }, admin));
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1').match(/\/Type \/Page\b/g)).toHaveLength(3);
  });
});
