import { PrismaClient, Role, MovementType } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  const bogota = await prisma.warehouse.upsert({
    where: { code: 'BOG-01' },
    update: {},
    create: { name: 'Bodega Principal Bogota', code: 'BOG-01', address: 'Cra 30 # 45-60, Bogota' },
  });

  const medellin = await prisma.warehouse.upsert({
    where: { code: 'MED-01' },
    update: {},
    create: { name: 'Bodega Medellin', code: 'MED-01', address: 'Calle 50 # 55-20, Medellin' },
  });

  const hashPw = (pw: string) => bcrypt.hash(pw, 10);

  const admin = await prisma.user.upsert({
    where: { username: 'admin' },
    update: {},
    create: { username: 'admin', name: 'Administrador', email: 'admin@wmspro.com', password: await hashPw('admin123'), role: Role.admin, warehouseId: bogota.id },
  });

  const supervisor = await prisma.user.upsert({
    where: { username: 'supervisor' },
    update: {},
    create: { username: 'supervisor', name: 'Carlos Supervisor', email: 'supervisor@wmspro.com', password: await hashPw('sup123'), role: Role.supervisor, warehouseId: bogota.id },
  });

  const operario = await prisma.user.upsert({
    where: { username: 'operario' },
    update: {},
    create: { username: 'operario', name: 'Juan Operario', email: 'operario@wmspro.com', password: await hashPw('op123'), role: Role.operator, warehouseId: bogota.id },
  });

  const productDefs = [
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

  const locs = ['A-01-01','A-01-02','B-01-01','B-02-03','C-01-01','C-02-05','A-03-02','A-02-01'];
  const created: Array<{ id: string; code: string; name: string; stock: number }> = [];

  for (let i = 0; i < productDefs.length; i++) {
    const p = productDefs[i];
    const product = await prisma.product.upsert({
      where: { code: p.code },
      update: {},
      create: { code: p.code, name: p.name, description: p.name, category: p.category, barcode: p.barcode, brand: p.brand, unit: p.unit, compatibility: [] },
    });
    await prisma.warehouseStock.upsert({
      where: { productId_warehouseId: { productId: product.id, warehouseId: bogota.id } },
      update: {},
      create: { productId: product.id, warehouseId: bogota.id, location: locs[i % locs.length], minStock: p.minStock, stockFisico: p.stock, stockReservado: 0 },
    });
    if (p.stock > 0) {
      await prisma.stockMovement.create({
        data: { productId: product.id, warehouseId: bogota.id, type: MovementType.inventario_inicial, quantity: p.stock, stockFisicoAntes: 0, stockFisicoDespues: p.stock, stockReservadoAntes: 0, stockReservadoDespues: 0, referenceType: 'seed', notes: 'Inventario inicial', operatorId: admin.id, operatorName: admin.name },
      });
    }
    created.push({ id: product.id, code: p.code, name: p.name, stock: p.stock });
  }

  const avail = created.filter((p) => p.stock >= 5);

  const pk3 = await prisma.pickingOrder.create({
    data: { reference: 'PK-2025-0001', client: 'Constructora Bolivar', warehouseId: bogota.id, status: 'pending', priority: 'high', assignedToId: operario.id, createdById: supervisor.id, items: { create: [{ productId: avail[0].id, productCode: avail[0].code, productName: avail[0].name, quantity: 3, pickedQuantity: 0, reservedQuantity: 0, unit: 'UND', location: 'A-01-01' }] } },
  });

  const pk4 = await prisma.pickingOrder.create({
    data: { reference: 'PK-2025-0002', client: 'Acme Corp', warehouseId: bogota.id, status: 'completed', priority: 'low', assignedToId: operario.id, createdById: supervisor.id, completedAt: new Date(), items: { create: [{ productId: avail[1].id, productCode: avail[1].code, productName: avail[1].name, quantity: 4, pickedQuantity: 4, reservedQuantity: 4, unit: 'UND', location: 'B-01-01' }] } },
  });

  await prisma.packingOrder.create({
    data: { pickingOrderId: pk4.id, reference: 'PCK-2025-0002', client: pk4.client, warehouseId: bogota.id, status: 'pending', assignedToId: operario.id, createdById: supervisor.id, items: { create: [{ productId: avail[1].id, productCode: avail[1].code, productName: avail[1].name, quantity: 4, packedQuantity: 0, unit: 'UND' }] } },
  });

  console.log('Seed completed. Users: admin/admin123  supervisor/sup123  operario/op123');
}

main().catch(console.error).finally(() => prisma.$disconnect());
