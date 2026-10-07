import { UnprocessableEntityException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { effectivePermissions } from '../src/auth/permissions';
import { AuthUser } from '../src/common/types/request-with-user.interface';
import { ImportKind, ImportsService } from '../src/imports/imports.service';
import { StockService } from '../src/stock/stock.service';
import { createTestTenant, deleteTestTenant, scopedTo, testPrisma } from './support/tenancy';

describe('CSV imports (integration)', () => {
  const prisma = testPrisma();
  let tenantId: string;
  let admin: AuthUser;
  let warehouseId: string;
  const imports = scopedTo(new ImportsService(prisma), () => tenantId);
  const stock = scopedTo(new StockService(prisma), () => tenantId);

  const run = (kind: ImportKind, csv: string, dryRun = false, user = admin) =>
    imports.run(kind, Buffer.from(csv), 'csv', dryRun, user);

  beforeAll(async () => {
    tenantId = (await createTestTenant(prisma)).id;
    const [main] = await Promise.all([
      prisma.warehouse.create({ data: { tenantId, code: 'MAIN', name: 'Main' } }),
      prisma.warehouse.create({ data: { tenantId, code: 'NORTH', name: 'North' } }),
    ]);
    warehouseId = main.id;
    admin = {
      id: (await prisma.user.create({
        data: { tenantId, username: 'admin', email: 'a@i.test', name: 'Admin', password: 'x', role: Role.admin },
      })).id,
      sub: '', tenantId, username: 'admin', name: 'Admin', role: Role.admin, warehouseId: null,
      permissions: effectivePermissions(Role.admin),
    };
  });

  afterAll(async () => {
    await deleteTestTenant(prisma, tenantId);
    await prisma.$disconnect();
  });

  it('creates and then updates products by code', async () => {
    const csv = 'code;name;category;barcode\nP-1;Tornillo;Ferretería;111\nP-2;"Tuerca; 3/8";Ferretería;\n';
    expect(await run('products', csv, true)).toMatchObject({ dryRun: true, created: 2, updated: 0, errors: [] });
    expect(await prisma.product.count({ where: { tenantId } })).toBe(0);

    await run('products', csv);
    expect(await run('products', 'code,name,category\nP-1,Tornillo largo,Ferretería\n')).toMatchObject({ created: 0, updated: 1 });
    const product = await prisma.product.findUniqueOrThrow({ where: { tenantId_code: { tenantId, code: 'P-1' } } });
    expect(product).toMatchObject({ name: 'Tornillo largo', barcode: '111' });
  });

  it('reports every invalid line and imports nothing', async () => {
    const csv = 'code,name,category,barcode\nP-9,Nuevo,X,111\nP-9,Repetido,X,\n,Sin código,X,\n';
    const result = await run('products', csv, true);
    expect(result.errors.map((e) => e.line)).toEqual([2, 3, 4]);
    await expect(run('products', csv)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(await prisma.product.count({ where: { tenantId, code: 'P-9' } })).toBe(0);
  });

  it('rejects files without the required columns', async () => {
    await expect(run('stock', 'warehouse,product\nMAIN,P-1\n')).rejects.toMatchObject({
      response: { error: 'IMPORT_MISSING_COLUMNS', details: { missing: ['quantity'] } },
    });
  });

  it('imports a location tree in any order and detects cycles', async () => {
    const csv = [
      'warehouse,code,type,parent,storable,capacity,pickSequence',
      'MAIN,a-01,bin,A,,50,1',
      'MAIN,A,aisle,,,,',
      'NORTH,Z,zone,,,,',
    ].join('\n');
    expect(await run('locations', csv)).toMatchObject({ created: 3, errors: [] });
    const bin = await prisma.location.findUniqueOrThrow({
      where: { warehouseId_code: { warehouseId, code: 'A-01' } },
      include: { parent: true },
    });
    expect(bin).toMatchObject({ storable: true, capacity: 50, pickSequence: 1, parent: { code: 'A' } });

    const cycle = 'warehouse,code,type,parent\nMAIN,A,aisle,A-01\n';
    expect((await run('locations', cycle, true)).errors[0].message).toMatch(/dentro de sí misma/);
  });

  it('adds opening balances into locations and rejects unknown references', async () => {
    const result = await run('stock', 'warehouse,product,quantity,location\nMAIN,P-1,30,A-01\nMAIN,P-1,5,\nMAIN,P-2,7,\n');
    expect(result).toMatchObject({ created: 3, errors: [] });
    expect(await stock.productLocations(
      (await prisma.product.findFirstOrThrow({ where: { tenantId, code: 'P-1' } })).id,
      warehouseId,
    )).toMatchObject({ onHand: 35, unlocated: 5, locations: [{ location: { code: 'A-01' }, quantity: 30 }] });

    const invalid = await run('stock', 'warehouse,product,quantity,location\nNOPE,P-1,1,\nMAIN,P-404,1,\nMAIN,P-1,0,\nMAIN,P-1,1,A\n', true);
    expect(invalid.errors.map((e) => e.line)).toEqual([2, 3, 4, 5]);
  });

  it('only imports into warehouses the user can reach', async () => {
    const supervisor: AuthUser = { ...admin, role: Role.supervisor, warehouseId, permissions: effectivePermissions(Role.supervisor) };
    const result = await run('stock', 'warehouse,product,quantity\nNORTH,P-1,1\n', true, supervisor);
    expect(result.errors[0].message).toMatch(/No tienes acceso/);
  });
});
