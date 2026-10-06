import { LocationType, OrderStatus, PrismaClient, Priority, Product, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { ActivityService } from '../src/activity/activity.service';
import { effectivePermissions } from '../src/auth/permissions';
import { AuthUser } from '../src/common/types/request-with-user.interface';
import { LocationsService } from '../src/locations/locations.service';
import { PackingService } from '../src/packing/packing.service';
import { PartnersService } from '../src/partners/partners.service';
import { PickingService } from '../src/picking/picking.service';
import { createPrismaClient } from '../src/prisma/prisma.service';
import { PurchaseOrdersService } from '../src/purchases/purchase-orders.service';
import { SalesOrdersService } from '../src/sales/sales-orders.service';
import { ShippingService } from '../src/shipping/shipping.service';
import { StockService } from '../src/stock/stock.service';
import { runInTenant } from '../src/tenancy/tenant-context';
import { PlanLimitsService } from '../src/tenancy/plan-limits.service';
import type { UploadsService } from '../src/uploads/uploads.service';

const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const DAY_MS = 24 * 60 * 60 * 1000;

const raw = new PrismaClient();
const prisma = createPrismaClient();

const PRODUCTS = [
  { code: 'FLT-0001', name: 'Filtro de Aceite CAT', category: 'Filtros', barcode: '7891234560001', brand: 'Caterpillar', unit: 'UND', stock: 45, minStock: 10 },
  { code: 'FLT-0002', name: 'Filtro de Combustible', category: 'Filtros', barcode: '7891234560002', brand: 'Caterpillar', unit: 'UND', stock: 0, minStock: 5 },
  { code: 'ROD-0001', name: 'Rodamiento SKF 6205', category: 'Rodamientos', barcode: '7891234560004', brand: 'SKF', unit: 'UND', stock: 120, minStock: 20 },
  { code: 'COR-0001', name: 'Correa Dentada Gates', category: 'Correas', barcode: '7891234560006', brand: 'Gates', unit: 'UND', stock: 8, minStock: 10 },
  { code: 'COR-0002', name: 'Correa Trapezoidal B-85', category: 'Correas', barcode: '7891234560007', brand: 'Gates', unit: 'UND', stock: 50, minStock: 15 },
  { code: 'RET-0001', name: 'Reten de Aceite 55x80', category: 'Retenes', barcode: '7891234560008', brand: 'SKF', unit: 'UND', stock: 30, minStock: 10 },
  { code: 'HID-0001', name: 'Manguera Hidraulica', category: 'Hidraulica', barcode: '7891234560010', brand: 'Parker', unit: 'MT', stock: 200, minStock: 50 },
  { code: 'HID-0002', name: 'Fitting Hidraulico', category: 'Hidraulica', barcode: '7891234560011', brand: 'Parker', unit: 'UND', stock: 85, minStock: 20 },
  { code: 'FLT-0004', name: 'Filtro Hidraulico Baldwin', category: 'Filtros', barcode: '7891234560013', brand: 'Baldwin', unit: 'UND', stock: 22, minStock: 8 },
  { code: 'ROD-0004', name: 'Rodamiento Rigido 6308', category: 'Rodamientos', barcode: '7891234560019', brand: 'FAG', unit: 'UND', stock: 60, minStock: 15 },
];

const LOT_PRODUCT = { code: 'ACE-0001', name: 'Aceite Hidraulico ISO 68 (galon)', category: 'Lubricantes', barcode: '7891234560030', brand: 'Mobil', unit: 'GL' };

const isoDate = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);

async function ensureBase() {
  const tenant = await raw.tenant.upsert({
    where: { slug: 'default' },
    update: {},
    create: { id: DEFAULT_TENANT_ID, slug: 'default', name: 'Default', plan: 'enterprise' },
  });
  const tenantId = tenant.id;
  const warehouse = (code: string, name: string, address: string) =>
    raw.warehouse.upsert({ where: { tenantId_code: { tenantId, code } }, update: {}, create: { tenantId, code, name, address } });
  const bogota = await warehouse('BOG-01', 'Bodega Principal Bogota', 'Cra 30 # 45-60, Bogota');
  const medellin = await warehouse('MED-01', 'Bodega Medellin', 'Calle 50 # 55-20, Medellin');

  const user = async (username: string, name: string, password: string, role: Role) =>
    raw.user.upsert({
      where: { tenantId_username: { tenantId, username } },
      update: {},
      create: { tenantId, username, name, email: `${username}@wmspro.com`, password: await bcrypt.hash(password, 10), role, warehouseId: bogota.id },
    });
  const admin = await user('admin', 'Administrador', 'admin123', Role.admin);
  await user('supervisor', 'Carlos Supervisor', 'sup123', Role.supervisor);
  const operario = await user('operario', 'Juan Operario', 'op123', Role.operator);

  return { tenantId, bogota, medellin, admin, operario };
}

// Demo data goes through the same services as the API so stock, locations, lots and reservations agree.
async function seedDemo(base: Awaited<ReturnType<typeof ensureBase>>) {
  const { tenantId, bogota, medellin } = base;
  const admin: AuthUser = {
    id: base.admin.id, sub: base.admin.id, tenantId, username: 'admin', name: base.admin.name,
    role: Role.admin, warehouseId: bogota.id, permissions: effectivePermissions(Role.admin),
  };
  const uploads = { deleteFile: () => Promise.resolve() } as unknown as UploadsService;
  const activity = new ActivityService(prisma);
  const planLimits = new PlanLimitsService(prisma);
  const stock = new StockService(prisma);
  const locations = new LocationsService(prisma);
  const picking = new PickingService(prisma, activity, uploads, planLimits);
  const packing = new PackingService(prisma, activity, uploads);
  const partners = new PartnersService(prisma);
  const purchases = new PurchaseOrdersService(prisma);
  const sales = new SalesOrdersService(prisma, picking, planLimits);
  const shipping = new ShippingService(prisma);

  await locations.generate(
    {
      warehouseId: bogota.id,
      levels: [
        { type: LocationType.aisle, start: 'A', count: 3 },
        { type: LocationType.rack, start: '01', count: 2 },
        { type: LocationType.bin, start: '1', count: 2 },
      ],
    },
    admin,
  );
  await locations.create({ warehouseId: bogota.id, code: 'MUELLE', name: 'Muelle de recepción', type: LocationType.dock }, admin);
  const bins = await prisma.location.findMany({ where: { warehouseId: bogota.id, type: LocationType.bin }, orderBy: { pickSequence: 'asc' } });

  const products: Product[] = [];
  for (const [index, def] of PRODUCTS.entries()) {
    const { stock: quantity, minStock, ...data } = def;
    const product = await prisma.product.create({ data: { ...data, description: def.name, tenantId } });
    await prisma.warehouseStock.createMany({
      data: [
        { tenantId, productId: product.id, warehouseId: bogota.id, minStock },
        { tenantId, productId: product.id, warehouseId: medellin.id, minStock },
      ],
    });
    if (quantity > 0) {
      const located = Math.ceil(quantity * 0.8);
      await stock.registerMovement({
        productId: product.id, warehouseId: bogota.id, type: 'opening_balance', quantity: located,
        locationId: bins[index % bins.length].id, notes: 'Inventario inicial', ...operator(admin),
      });
      if (quantity > located) {
        await stock.registerMovement({ productId: product.id, warehouseId: bogota.id, type: 'opening_balance', quantity: quantity - located, notes: 'Inventario inicial', ...operator(admin) });
      }
    }
    if (index % 3 === 0) {
      await stock.registerMovement({ productId: product.id, warehouseId: medellin.id, type: 'opening_balance', quantity: 12, notes: 'Inventario inicial', ...operator(admin) });
    }
    products.push(product);
  }

  const oil = await prisma.product.create({ data: { ...LOT_PRODUCT, description: LOT_PRODUCT.name, lotTracking: true, tenantId } });
  await prisma.warehouseStock.create({ data: { tenantId, productId: oil.id, warehouseId: bogota.id, minStock: 10 } });
  for (const [code, days, quantity] of [['L-2601', 20, 12], ['L-2602', 240, 30]] as const) {
    await stock.registerMovement({
      productId: oil.id, warehouseId: bogota.id, type: 'purchase_receipt', quantity, locationId: bins[bins.length - 1].id,
      lot: { code, expiresAt: new Date(isoDate(days)) }, notes: 'Inventario inicial', ...operator(admin),
    });
  }

  const bolivar = await partners.create({ code: 'CLI-001', name: 'Constructora Bolivar', isCustomer: true, city: 'Bogota', taxId: '900123456-7' });
  const acme = await partners.create({ code: 'CLI-002', name: 'Acme Corp', isCustomer: true, city: 'Medellin' });
  const supplier = await partners.create({ code: 'PRV-001', name: 'Distribuidora Andina', isSupplier: true, email: 'compras@andina.example' });
  await shipping.createCarrier({ name: 'Servientrega', trackingUrlTemplate: 'https://www.servientrega.com/wps/portal/rastreo-envio?guia={tracking}' });

  const byCode = (code: string) => products.find((product) => product.code === code)!;

  await picking.create(
    { customerId: bolivar.id, warehouseId: bogota.id, priority: Priority.high, assignedToId: base.operario.id, items: [{ productId: byCode('ROD-0001').id, quantity: 6 }, { productId: byCode('COR-0002').id, quantity: 4 }] },
    admin,
  );

  const shipped = await picking.create({ customerId: acme.id, warehouseId: bogota.id, priority: Priority.low, items: [{ productId: byCode('FLT-0001').id, quantity: 4 }] }, admin);
  await picking.updateItem(shipped.id, shipped.items[0].id, 4, admin);
  await picking.updateStatus(shipped.id, OrderStatus.in_progress, admin);
  await picking.updateStatus(shipped.id, OrderStatus.completed, admin);
  await packing.create({ pickingOrderId: shipped.id, assignedToId: base.operario.id }, admin);

  await sales.create(
    { customerId: bolivar.id, warehouseId: bogota.id, requestedAt: isoDate(3), items: [{ productId: byCode('HID-0002').id, quantity: 10 }, { productId: oil.id, quantity: 5 }] },
    admin,
  );

  await purchases.create(
    { supplierId: supplier.id, warehouseId: bogota.id, expectedAt: isoDate(5), items: [{ productId: byCode('FLT-0002').id, quantity: 40 }, { productId: byCode('COR-0001').id, quantity: 20 }] },
    admin,
  );
}

const operator = (user: AuthUser) => ({ operatorId: user.id, operatorName: user.name });

async function main() {
  console.log('Seeding database...');
  const base = await ensureBase();
  const hasData = (await raw.product.count({ where: { tenantId: base.tenantId } })) > 0;
  if (hasData) {
    console.log('Demo data already present; only users and warehouses were ensured.');
  } else {
    await runInTenant(base.tenantId, () => seedDemo(base));
    console.log('Demo data created.');
  }
  console.log('Seed completed. Tenant: default. Users: admin/admin123  supervisor/sup123  operario/op123');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => Promise.all([raw.$disconnect(), prisma.$disconnect()]));
