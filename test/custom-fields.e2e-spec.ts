import { CustomFieldEntity, CustomFieldType, LocationType, Role } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { effectivePermissions } from '../src/auth/permissions';
import { AuthUser } from '../src/common/types/request-with-user.interface';
import { CustomFieldsService } from '../src/custom-fields/custom-fields.service';
import { LocationsService } from '../src/locations/locations.service';
import { PartnersService } from '../src/partners/partners.service';
import { ProductsService } from '../src/products/products.service';
import { UploadsService } from '../src/uploads/uploads.service';
import { createTestTenant, deleteTestTenant, scopedTo, testPrisma } from './support/tenancy';

describe('Custom fields (integration)', () => {
  const prisma = testPrisma();
  let tenantId: string;
  let otherTenantId: string;
  const scoped = <T extends object>(service: T, tenant: () => string = () => tenantId) => scopedTo(service, tenant);
  const uploads = { deleteFile: () => undefined } as unknown as UploadsService;
  const fields = scoped(new CustomFieldsService(prisma));
  const otherFields = scoped(new CustomFieldsService(prisma), () => otherTenantId);
  const products = scoped(new ProductsService(prisma, uploads));
  const otherProducts = scoped(new ProductsService(prisma, uploads), () => otherTenantId);
  const partners = scoped(new PartnersService(prisma));
  const locations = scoped(new LocationsService(prisma));
  let admin: AuthUser;
  let warehouseId: string;

  beforeAll(async () => {
    [tenantId, otherTenantId] = (await Promise.all([createTestTenant(prisma), createTestTenant(prisma)])).map((t) => t.id);
    warehouseId = (await prisma.warehouse.create({ data: { tenantId, code: 'W', name: 'W' } })).id;
    admin = {
      id: 'u', sub: 'u', tenantId, username: 'a', name: 'A', role: Role.admin, warehouseId: null,
      permissions: effectivePermissions(Role.admin),
    };
    await fields.create({ entity: CustomFieldEntity.product, key: 'origen', label: 'País de origen', type: CustomFieldType.select, options: ['CO', 'MX'], required: true });
    await fields.create({ entity: CustomFieldEntity.product, key: 'peso_kg', label: 'Peso (kg)', type: CustomFieldType.number });
    await fields.create({ entity: CustomFieldEntity.partner, key: 'credito', label: 'Crédito aprobado', type: CustomFieldType.boolean });
    await fields.create({ entity: CustomFieldEntity.location, key: 'temperatura', label: 'Temperatura', type: CustomFieldType.text });
  });

  afterAll(async () => {
    await deleteTestTenant(prisma, tenantId);
    await deleteTestTenant(prisma, otherTenantId);
    await prisma.$disconnect();
  });

  it('validates product values on create and merges them on update', async () => {
    await expect(products.create({ code: 'P-0', name: 'Sin origen', category: 'c' })).rejects.toMatchObject({
      response: { error: 'CUSTOM_FIELDS_INVALID', details: [{ key: 'origen' }] },
    });
    const product = await products.create({ code: 'P-1', name: 'Café', category: 'c', customFields: { origen: 'CO', peso_kg: 0.5 } });
    expect(product.customFields).toEqual({ origen: 'CO', peso_kg: 0.5 });

    const updated = await products.update(product.id, { customFields: { peso_kg: null } });
    expect(updated.customFields).toEqual({ origen: 'CO' });
    await expect(products.update(product.id, { customFields: { origen: 'AR' } })).rejects.toMatchObject({
      response: { error: 'CUSTOM_FIELDS_INVALID' },
    });
    expect((await products.update(product.id, { name: 'Café tostado' })).customFields).toEqual({ origen: 'CO' });
  });

  it('applies the definitions of each entity to partners and locations', async () => {
    const partner = await partners.create({ code: 'C1', name: 'Cliente', isCustomer: true, customFields: { credito: true } });
    expect(partner.customFields).toEqual({ credito: true });
    await expect(partners.create({ code: 'C2', name: 'Otro', isCustomer: true, customFields: { origen: 'CO' } })).rejects.toMatchObject({
      response: { details: [{ key: 'origen', message: 'Campo desconocido' }] },
    });

    const location = await locations.create({ warehouseId, code: 'F-1', type: LocationType.bin, customFields: { temperatura: '2-8 °C' } }, admin);
    expect(location.customFields).toEqual({ temperatura: '2-8 °C' });
  });

  it('ignores deactivated fields and keeps definitions per tenant', async () => {
    const [weight] = await fields.findAll(CustomFieldEntity.product).then((all) => all.filter((f) => f.key === 'peso_kg'));
    await fields.update(weight.id, { active: false });
    await expect(products.create({ code: 'P-2', name: 'Té', category: 'c', customFields: { origen: 'MX', peso_kg: 1 } })).rejects.toMatchObject({
      response: { details: [{ key: 'peso_kg' }] },
    });

    expect(await otherFields.findAll()).toEqual([]);
    expect((await otherProducts.create({ code: 'P-1', name: 'Libre', category: 'c' })).customFields).toEqual({});
  });

  it('requires options only for select fields', async () => {
    await expect(fields.create({ entity: CustomFieldEntity.product, key: 'talla', label: 'Talla', type: CustomFieldType.select })).rejects.toMatchObject({
      response: { error: 'CUSTOM_FIELD_OPTIONS_REQUIRED' },
    });
    await expect(
      fields.create({ entity: CustomFieldEntity.product, key: 'nota', label: 'Nota', type: CustomFieldType.text, options: ['x'] }),
    ).rejects.toMatchObject({ response: { error: 'CUSTOM_FIELD_OPTIONS_NOT_ALLOWED' } });
  });
});
