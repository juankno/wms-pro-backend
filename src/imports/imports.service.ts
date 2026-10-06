import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { LocationType, Prisma } from '@prisma/client';
import { AuthUser } from '../common/types/request-with-user.interface';
import { assertWarehouseAccess } from '../common/utils/warehouse-scope';
import { STORABLE_TYPES } from '../locations/locations.service';
import { PrismaService } from '../prisma/prisma.service';
import { putAway } from '../stock/location-stock';
import { lockWarehouseStock } from '../stock/stock-lock';
import { requireTenantId } from '../tenancy/tenant-context';
import {
  CsvRow,
  lineOf,
  MAX_IMPORT_ROWS,
  missingColumns,
  parseBoolean,
  parseCsv,
  parseDate,
  parsePositiveInt,
  RowError,
} from './csv';
import { receiveIntoLot } from '../stock/lot-stock';

export const IMPORT_KINDS = ['products', 'locations', 'stock'] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export const IMPORT_TEMPLATES: Record<ImportKind, string> = {
  products:
    'code,name,category,barcode,unit,brand,description,lotTracking\n' +
    'TOR-001,Tornillo 3/8,Ferretería,7701234567890,UND,Acme,Tornillo de acero,no\n',
  locations: 'warehouse,code,type,parent,name,storable,capacity,pickSequence\nBOG-01,A,aisle,,Pasillo A,no,,\nBOG-01,A-01,bin,A,,si,100,1\n',
  stock: 'warehouse,product,quantity,location,lot,expiresAt\nBOG-01,TOR-001,50,A-01,,\n',
};

const REQUIRED_COLUMNS: Record<ImportKind, string[]> = {
  products: ['code', 'name', 'category'],
  locations: ['warehouse', 'code', 'type'],
  stock: ['warehouse', 'product', 'quantity'],
};

const MAX_REPORTED_ERRORS = 200;
const IMPORT_TIMEOUT_MS = 120_000;
const LOCATION_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LOCATION_TYPES = new Set<string>(Object.values(LocationType));
const MAX_PARENT_DEPTH = 100;

type Tx = Prisma.TransactionClient;

interface ImportPlan {
  created: number;
  updated: number;
  errors: RowError[];
  apply: (tx: Tx) => Promise<void>;
}

export interface ImportResult {
  dryRun: boolean;
  total: number;
  created: number;
  updated: number;
  errors: RowError[];
}

const unique = (values: string[]) => [...new Set(values.filter(Boolean))];

@Injectable()
export class ImportsService {
  constructor(private prisma: PrismaService) {}

  // Validates every row first; nothing is written unless the whole file is valid.
  async run(kind: ImportKind, content: Buffer, dryRun: boolean, user: AuthUser): Promise<ImportResult> {
    const rows = this.readRows(kind, content);
    const plan = await this.plan(kind, rows, user);
    const result = { dryRun, total: rows.length, created: plan.created, updated: plan.updated, errors: plan.errors };

    if (plan.errors.length > 0) {
      if (dryRun) return result;
      throw new UnprocessableEntityException({
        error: 'IMPORT_INVALID',
        message: 'El archivo tiene errores; no se importó nada',
        details: plan.errors,
      });
    }
    if (!dryRun) await this.prisma.$transaction((tx) => plan.apply(tx), { timeout: IMPORT_TIMEOUT_MS });
    return result;
  }

  private readRows(kind: ImportKind, content: Buffer): CsvRow[] {
    let rows: CsvRow[];
    try {
      rows = parseCsv(content);
    } catch (error) {
      throw new UnprocessableEntityException({ error: 'IMPORT_INVALID_CSV', message: `CSV inválido: ${(error as Error).message}` });
    }
    if (rows.length === 0) throw new UnprocessableEntityException({ error: 'IMPORT_EMPTY', message: 'El archivo no tiene filas' });
    if (rows.length > MAX_IMPORT_ROWS) {
      throw new UnprocessableEntityException({
        error: 'IMPORT_TOO_LARGE',
        message: `El archivo tiene ${rows.length} filas; el máximo es ${MAX_IMPORT_ROWS}`,
      });
    }
    const missing = missingColumns(rows, REQUIRED_COLUMNS[kind]);
    if (missing.length > 0) {
      throw new UnprocessableEntityException({
        error: 'IMPORT_MISSING_COLUMNS',
        message: `Faltan columnas: ${missing.join(', ')}`,
        details: { missing },
      });
    }
    return rows;
  }

  private async plan(kind: ImportKind, rows: CsvRow[], user: AuthUser): Promise<ImportPlan> {
    const plan =
      kind === 'products'
        ? await this.planProducts(rows)
        : kind === 'locations'
          ? await this.planLocations(rows, user)
          : await this.planStock(rows, user);
    return { ...plan, errors: plan.errors.slice(0, MAX_REPORTED_ERRORS) };
  }

  private async planProducts(rows: CsvRow[]): Promise<ImportPlan> {
    const errors: RowError[] = [];
    const codes = unique(rows.map((row) => row.code));
    const barcodes = unique(rows.map((row) => row.barcode ?? ''));
    const [existing, barcodeOwners, extraBarcodes] = await Promise.all([
      this.prisma.product.findMany({
        where: { code: { in: codes } },
        select: { code: true, lotTracking: true, warehouseStock: { select: { onHand: true } } },
      }),
      this.prisma.product.findMany({ where: { barcode: { in: barcodes } }, select: { code: true, barcode: true } }),
      this.prisma.productBarcode.findMany({ where: { code: { in: barcodes } }, select: { code: true, product: { select: { code: true } } } }),
    ]);
    const existingByCode = new Map(existing.map((product) => [product.code, product]));
    const seenCodes = new Set<string>();
    const seenBarcodes = new Set<string>();

    rows.forEach((row, index) => {
      const line = lineOf(index);
      if (!row.code || !row.name || !row.category) errors.push({ line, message: 'code, name y category son obligatorios' });
      if (seenCodes.has(row.code)) errors.push({ line, message: `El código ${row.code} está repetido en el archivo` });
      seenCodes.add(row.code);

      const lotTracking = parseBoolean(row.lotTracking);
      if (row.lotTracking && lotTracking === undefined) errors.push({ line, message: `lotTracking debe ser si o no: ${row.lotTracking}` });
      const current = existingByCode.get(row.code);
      const hasStock = current?.warehouseStock.some((stock) => stock.onHand > 0);
      if (current && lotTracking !== undefined && lotTracking !== current.lotTracking && hasStock) {
        errors.push({ line, message: `${row.code} tiene stock; no se puede cambiar el manejo de lotes` });
      }

      if (!row.barcode) return;
      if (seenBarcodes.has(row.barcode)) errors.push({ line, message: `El código de barras ${row.barcode} está repetido en el archivo` });
      seenBarcodes.add(row.barcode);
      const owner = barcodeOwners.find((product) => product.barcode === row.barcode && product.code !== row.code);
      const extra = extraBarcodes.find((barcode) => barcode.code === row.barcode);
      const takenBy = owner?.code ?? extra?.product.code;
      if (takenBy) errors.push({ line, message: `El código de barras ${row.barcode} ya es del producto ${takenBy}` });
    });

    const created = rows.filter((row) => !existingByCode.has(row.code)).length;
    return {
      errors,
      created,
      updated: rows.length - created,
      apply: async (tx) => {
        const tenantId = requireTenantId();
        for (const row of rows) {
          const data = {
            name: row.name,
            category: row.category,
            barcode: row.barcode || undefined,
            unit: row.unit || undefined,
            brand: row.brand || undefined,
            description: row.description || undefined,
            lotTracking: parseBoolean(row.lotTracking),
          };
          await tx.product.upsert({
            where: { tenantId_code: { tenantId, code: row.code } },
            create: { ...data, code: row.code, tenantId },
            update: data,
          });
        }
      },
    };
  }

  private async planLocations(rows: CsvRow[], user: AuthUser): Promise<ImportPlan> {
    const errors: RowError[] = [];
    const warehouses = await this.warehousesByCode(rows);
    const warehouseIds = [...warehouses.values()].map((warehouse) => warehouse.id);
    const existing = await this.prisma.location.findMany({
      where: { warehouseId: { in: warehouseIds } },
      select: { id: true, code: true, warehouseId: true, parentId: true },
    });
    const key = (warehouseId: string, code: string) => `${warehouseId}:${code}`;
    const existingByKey = new Map(existing.map((location) => [key(location.warehouseId, location.code), location]));
    const existingById = new Map(existing.map((location) => [location.id, location]));

    // Final parent of every location after the import: database values overridden by the file.
    const parentOf = new Map<string, string | null>();
    for (const location of existing) {
      const parent = location.parentId ? existingById.get(location.parentId) : undefined;
      parentOf.set(key(location.warehouseId, location.code), parent ? key(parent.warehouseId, parent.code) : null);
    }

    const parsed = rows.map((row, index) => {
      const line = lineOf(index);
      const warehouse = this.accessibleWarehouse(warehouses, row.warehouse, user, line, errors);
      const code = row.code.toUpperCase();
      const parent = row.parent ? row.parent.toUpperCase() : null;
      if (!LOCATION_CODE.test(code)) errors.push({ line, message: `Código de ubicación inválido: ${row.code}` });
      if (!LOCATION_TYPES.has(row.type)) errors.push({ line, message: `Tipo inválido: ${row.type}` });
      if (parent === code) errors.push({ line, message: 'Una ubicación no puede ser su propio padre' });

      const storable = parseBoolean(row.storable);
      if (row.storable && storable === undefined) errors.push({ line, message: `storable debe ser si o no: ${row.storable}` });
      const capacity = parsePositiveInt(row.capacity);
      if (row.capacity && capacity === undefined) errors.push({ line, message: `Capacidad inválida: ${row.capacity}` });
      if (row.pickSequence && !/^\d+$/.test(row.pickSequence)) {
        errors.push({ line, message: `pickSequence inválido: ${row.pickSequence}` });
      }
      if (warehouse) parentOf.set(key(warehouse.id, code), parent ? key(warehouse.id, parent) : null);
      return { line, row, warehouse, code, parent, storable, capacity, pickSequence: row.pickSequence ? Number(row.pickSequence) : undefined };
    });

    const seen = new Set<string>();
    for (const item of parsed) {
      if (!item.warehouse) continue;
      const itemKey = key(item.warehouse.id, item.code);
      if (seen.has(itemKey)) errors.push({ line: item.line, message: `La ubicación ${item.code} está repetida en el archivo` });
      seen.add(itemKey);
      if (item.parent && !parentOf.has(key(item.warehouse.id, item.parent))) {
        errors.push({ line: item.line, message: `La ubicación padre ${item.parent} no existe en ${item.row.warehouse}` });
      }
      if (this.hasCycle(itemKey, parentOf)) {
        errors.push({ line: item.line, message: `La ubicación ${item.code} quedaría dentro de sí misma` });
      }
    }

    const created = parsed.filter((item) => item.warehouse && !existingByKey.has(key(item.warehouse.id, item.code))).length;
    return {
      errors,
      created,
      updated: rows.length - created,
      apply: async (tx) => {
        const tenantId = requireTenantId();
        for (const item of parsed) {
          const type = item.row.type as LocationType;
          const data = { type, name: item.row.name || undefined, capacity: item.capacity, pickSequence: item.pickSequence };
          await tx.location.upsert({
            where: { warehouseId_code: { warehouseId: item.warehouse!.id, code: item.code } },
            create: { ...data, tenantId, warehouseId: item.warehouse!.id, code: item.code, storable: item.storable ?? STORABLE_TYPES.has(type) },
            update: { ...data, storable: item.storable },
          });
        }
        const saved = await tx.location.findMany({
          where: { warehouseId: { in: warehouseIds } },
          select: { id: true, code: true, warehouseId: true },
        });
        const idByKey = new Map(saved.map((location) => [key(location.warehouseId, location.code), location.id]));
        for (const item of parsed) {
          const warehouseId = item.warehouse!.id;
          await tx.location.update({
            where: { id: idByKey.get(key(warehouseId, item.code))! },
            data: { parentId: item.parent ? idByKey.get(key(warehouseId, item.parent))! : null },
          });
        }
      },
    };
  }

  private async planStock(rows: CsvRow[], user: AuthUser): Promise<ImportPlan> {
    const errors: RowError[] = [];
    const warehouses = await this.warehousesByCode(rows);
    const products = await this.prisma.product.findMany({
      where: { code: { in: unique(rows.map((row) => row.product)) }, active: true },
      select: { id: true, code: true, lotTracking: true },
    });
    const productByCode = new Map(products.map((product) => [product.code, product]));
    const locations = await this.prisma.location.findMany({
      where: {
        warehouseId: { in: [...warehouses.values()].map((warehouse) => warehouse.id) },
        code: { in: unique(rows.map((row) => (row.location ?? '').toUpperCase())) },
      },
    });

    const entries = rows.map((row, index) => {
      const line = lineOf(index);
      const warehouse = this.accessibleWarehouse(warehouses, row.warehouse, user, line, errors);
      const product = productByCode.get(row.product);
      if (!product) errors.push({ line, message: `El producto ${row.product} no existe o está inactivo` });
      const quantity = parsePositiveInt(row.quantity);
      if (quantity === undefined) errors.push({ line, message: `Cantidad inválida: ${row.quantity}` });

      let locationId: string | undefined;
      if (row.location && warehouse) {
        const location = locations.find((l) => l.warehouseId === warehouse.id && l.code === row.location.toUpperCase());
        if (!location?.active) errors.push({ line, message: `La ubicación ${row.location} no existe en ${row.warehouse}` });
        else if (!location.storable) errors.push({ line, message: `La ubicación ${row.location} no admite stock` });
        else locationId = location.id;
      }
      const expiresAt = row.expiresAt ? parseDate(row.expiresAt) : undefined;
      if (row.expiresAt && !expiresAt) errors.push({ line, message: `Fecha de vencimiento inválida (AAAA-MM-DD): ${row.expiresAt}` });
      if (product?.lotTracking && !row.lot) errors.push({ line, message: `${row.product} maneja lotes; indica el lote` });
      if (product && !product.lotTracking && row.lot) errors.push({ line, message: `${row.product} no maneja lotes` });
      const lot = row.lot ? { code: row.lot, expiresAt } : undefined;

      return { warehouseId: warehouse?.id, productId: product?.id, quantity, locationId, lot };
    });

    return {
      errors,
      created: rows.length,
      updated: 0,
      apply: async (tx) => {
        const tenantId = requireTenantId();
        for (const entry of entries) {
          const productId = entry.productId!;
          const warehouseId = entry.warehouseId!;
          const quantity = entry.quantity!;
          await tx.warehouseStock.upsert({
            where: { productId_warehouseId: { productId, warehouseId } },
            create: { tenantId, productId, warehouseId },
            update: {},
          });
          const stock = (await lockWarehouseStock(tx, productId, warehouseId))!;
          if (entry.locationId) await putAway(tx, stock, entry.locationId, quantity);
          const lotId = await receiveIntoLot(tx, stock, quantity, entry.lot);
          await tx.warehouseStock.update({ where: { id: stock.id }, data: { onHand: stock.onHand + quantity } });
          await tx.stockMovement.create({
            data: {
              tenantId,
              productId,
              warehouseId,
              type: 'opening_balance',
              quantity,
              onHandBefore: stock.onHand,
              onHandAfter: stock.onHand + quantity,
              reservedBefore: stock.reserved,
              reservedAfter: stock.reserved,
              referenceType: 'import',
              notes: 'Importación CSV',
              operatorId: user.id,
              operatorName: user.name,
              locationId: entry.locationId,
              lotId,
            },
          });
        }
      },
    };
  }

  private async warehousesByCode(rows: CsvRow[]) {
    const warehouses = await this.prisma.warehouse.findMany({
      where: { code: { in: unique(rows.map((row) => row.warehouse)) }, active: true },
      select: { id: true, code: true },
    });
    return new Map(warehouses.map((warehouse) => [warehouse.code, warehouse]));
  }

  private accessibleWarehouse(
    warehouses: Map<string, { id: string; code: string }>,
    code: string,
    user: AuthUser,
    line: number,
    errors: RowError[],
  ) {
    const warehouse = warehouses.get(code);
    if (!warehouse) {
      errors.push({ line, message: `El almacén ${code} no existe o está inactivo` });
      return undefined;
    }
    try {
      assertWarehouseAccess(user, warehouse.id);
      return warehouse;
    } catch {
      errors.push({ line, message: `No tienes acceso al almacén ${code}` });
      return undefined;
    }
  }

  private hasCycle(start: string, parentOf: Map<string, string | null>) {
    let current = parentOf.get(start) ?? null;
    for (let depth = 0; current && depth < MAX_PARENT_DEPTH; depth++) {
      if (current === start) return true;
      current = parentOf.get(current) ?? null;
    }
    return false;
  }
}
