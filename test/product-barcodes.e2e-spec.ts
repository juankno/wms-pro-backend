import { ConflictException, NotFoundException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProductsService } from '../src/products/products.service';
import { UploadsService } from '../src/uploads/uploads.service';
import { createTestTenant, deleteTestTenant, scopedTo, testPrisma } from './support/tenancy';

describe('Product barcodes (integration)', () => {
  const prisma = testPrisma();
  let tenantId: string;
  let otherTenantId: string;
  const uploads = { deleteFile: () => undefined } as unknown as UploadsService;
  const products = scopedTo(new ProductsService(prisma, uploads), () => tenantId);
  const otherProducts = scopedTo(new ProductsService(prisma, uploads), () => otherTenantId);

  beforeAll(async () => {
    [tenantId, otherTenantId] = (await Promise.all([createTestTenant(prisma), createTestTenant(prisma)])).map((t) => t.id);
  });

  afterAll(async () => {
    await deleteTestTenant(prisma, tenantId);
    await deleteTestTenant(prisma, otherTenantId);
    await prisma.$disconnect();
  });

  it('resolves extra barcodes with their pack quantity and the main one as a single unit', async () => {
    const product = await products.create({ code: 'P-1', name: 'Tornillo', category: 'c', barcode: '1000' });
    await products.addBarcode(product.id, { code: '1012', quantity: 12, label: 'Caja x12' });

    expect(await products.findByBarcode('1000', undefined)).toMatchObject({ id: product.id, scanQuantity: 1, packaging: null });
    expect(await products.findByBarcode('1012', undefined)).toMatchObject({ id: product.id, scanQuantity: 12, packaging: 'Caja x12' });
    expect((await products.findAll({ search: '1012', page: 1, limit: 10 }, undefined)).data.map((p) => p.id)).toEqual([product.id]);
  });

  it('keeps main and extra barcodes unique per tenant', async () => {
    const first = await products.create({ code: 'P-2', name: 'Tuerca', category: 'c', barcode: '2000' });
    const second = await products.create({ code: 'P-3', name: 'Arandela', category: 'c' });
    await products.addBarcode(first.id, { code: '2006', quantity: 6 });

    await expect(products.addBarcode(second.id, { code: '2000' })).rejects.toBeInstanceOf(ConflictException);
    await expect(products.update(second.id, { barcode: '2006' })).rejects.toBeInstanceOf(ConflictException);
    await expect(products.create({ code: 'P-4', name: 'X', category: 'c', barcode: '2006' })).rejects.toBeInstanceOf(ConflictException);

    const foreign = await otherProducts.create({ code: 'P-2', name: 'Ajeno', category: 'c' });
    await expect(otherProducts.addBarcode(foreign.id, { code: '2006' })).resolves.toMatchObject({ quantity: 1 });
  });

  it('removes only barcodes of the given product', async () => {
    const product = await products.create({ code: 'P-5', name: 'Clavo', category: 'c' });
    const other = await products.create({ code: 'P-6', name: 'Grapa', category: 'c' });
    const barcode = await products.addBarcode(product.id, { code: '5005' });

    await expect(products.removeBarcode(other.id, barcode.id)).rejects.toBeInstanceOf(NotFoundException);
    await products.removeBarcode(product.id, barcode.id);
    await expect(products.findByBarcode('5005', undefined)).rejects.toBeInstanceOf(NotFoundException);
  });
});
