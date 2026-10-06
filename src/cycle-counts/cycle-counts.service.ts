import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { CycleCountStatus, Prisma, WarehouseStock } from '@prisma/client';
import { buildMeta, paginate } from '../common/dto/pagination.dto';
import { AuthUser } from '../common/types/request-with-user.interface';
import { assertWarehouseAccess } from '../common/utils/warehouse-scope';
import { PrismaService } from '../prisma/prisma.service';
import { nextReference } from '../sequences/sequence';
import { assertUnlocatedAvailable, putAway, takeFromLocation } from '../stock/location-stock';
import { receiveIntoLot, singleLot, takeFromLots } from '../stock/lot-stock';
import { lockWarehouseStock } from '../stock/stock-lock';
import { requireTenantId } from '../tenancy/tenant-context';

type Tx = Prisma.TransactionClient;

const COUNT_INCLUDE = {
  warehouse: { select: { id: true, code: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  approvedBy: { select: { id: true, name: true } },
  lines: {
    include: {
      product: { select: { id: true, code: true, name: true, unit: true, lotTracking: true } },
      location: { select: { id: true, code: true, pickSequence: true } },
    },
  },
} satisfies Prisma.CycleCountInclude;

type CountWithLines = Prisma.CycleCountGetPayload<{ include: typeof COUNT_INCLUDE }>;

const NOT_FOUND = { error: 'CYCLE_COUNT_NOT_FOUND', message: 'Conteo no encontrado' };

// Walking order, units without location last, then product code.
const byRoute = (a: CountWithLines['lines'][number], b: CountWithLines['lines'][number]) =>
  (a.location?.pickSequence ?? Number.MAX_SAFE_INTEGER) - (b.location?.pickSequence ?? Number.MAX_SAFE_INTEGER) ||
  (a.location?.code ?? '').localeCompare(b.location?.code ?? '') ||
  a.product.code.localeCompare(b.product.code);

@Injectable()
export class CycleCountsService {
  constructor(private prisma: PrismaService) {}

  async findAll(opts: { status?: CycleCountStatus; warehouseId?: string; page: number; limit: number }) {
    const where: Prisma.CycleCountWhereInput = { status: opts.status, warehouseId: opts.warehouseId };
    const [data, total] = await Promise.all([
      this.prisma.cycleCount.findMany({
        where,
        include: { warehouse: { select: { id: true, code: true, name: true } }, _count: { select: { lines: true } } },
        orderBy: { createdAt: 'desc' },
        ...paginate(opts.page, opts.limit),
      }),
      this.prisma.cycleCount.count({ where }),
    ]);
    return { data, meta: buildMeta(total, opts.page, opts.limit) };
  }

  // Blind counts hide expected quantities from counters while counting.
  async findById(id: string, user: AuthUser) {
    const count = await this.prisma.cycleCount.findUnique({ where: { id }, include: COUNT_INCLUDE });
    if (!count) throw new NotFoundException(NOT_FOUND);
    assertWarehouseAccess(user, count.warehouseId);
    const hideExpected = count.blind && count.status === CycleCountStatus.open && !user.permissions.includes('counts.manage');
    return {
      ...count,
      lines: count.lines.sort(byRoute).map((line) => ({
        ...line,
        expectedQuantity: hideExpected ? null : line.expectedQuantity,
        difference: hideExpected || line.countedQuantity === null ? null : line.countedQuantity - line.expectedQuantity,
      })),
    };
  }

  async create(dto: { warehouseId: string; locationIds?: string[]; productIds?: string[]; blind?: boolean; notes?: string }, user: AuthUser) {
    assertWarehouseAccess(user, dto.warehouseId);
    if (!dto.locationIds?.length && !dto.productIds?.length) {
      throw new UnprocessableEntityException({ error: 'COUNT_SCOPE_REQUIRED', message: 'Indica las ubicaciones o los productos a contar' });
    }
    const count = await this.prisma.$transaction(async (tx) => {
      const lines = new Map<string, { productId: string; locationId: string | null; expectedQuantity: number }>();
      const add = (productId: string, locationId: string | null, expectedQuantity: number) =>
        lines.set(`${productId}:${locationId ?? ''}`, { productId, locationId, expectedQuantity });

      if (dto.locationIds?.length) {
        const locations = await tx.location.findMany({ where: { id: { in: dto.locationIds }, warehouseId: dto.warehouseId } });
        if (locations.length !== new Set(dto.locationIds).size) {
          throw new NotFoundException({ error: 'LOCATION_NOT_FOUND', message: 'Alguna ubicación no existe en el almacén' });
        }
        const stock = await tx.locationStock.findMany({ where: { locationId: { in: dto.locationIds }, quantity: { gt: 0 } } });
        stock.forEach((row) => add(row.productId, row.locationId, row.quantity));
      }

      if (dto.productIds?.length) {
        const [stocks, located] = await Promise.all([
          tx.warehouseStock.findMany({ where: { warehouseId: dto.warehouseId, productId: { in: dto.productIds } } }),
          tx.locationStock.findMany({ where: { warehouseId: dto.warehouseId, productId: { in: dto.productIds }, quantity: { gt: 0 } } }),
        ]);
        for (const productId of dto.productIds) {
          const rows = located.filter((row) => row.productId === productId);
          rows.forEach((row) => add(productId, row.locationId, row.quantity));
          const stock = stocks.find((row) => row.productId === productId);
          const inLocations = rows.reduce((sum, row) => sum + row.quantity, 0);
          add(productId, null, stock ? stock.onHand - stock.picked - inLocations : 0);
        }
      }

      const reference = await nextReference(tx, 'count', async (candidate) => !!(await tx.cycleCount.findFirst({ where: { reference: candidate } })));
      return tx.cycleCount.create({
        data: {
          tenantId: requireTenantId(),
          reference,
          warehouseId: dto.warehouseId,
          blind: dto.blind ?? false,
          notes: dto.notes,
          createdById: user.id,
          lines: { create: [...lines.values()] },
        },
      });
    });
    return this.findById(count.id, user);
  }

  async recordCount(id: string, lineId: string, dto: { countedQuantity: number; lotCode?: string }, user: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      await this.lockCount(tx, id, user, [CycleCountStatus.open]);
      const { count } = await tx.cycleCountLine.updateMany({
        where: { id: lineId, cycleCountId: id },
        data: { countedQuantity: dto.countedQuantity, lotCode: dto.lotCode?.trim().toUpperCase(), countedById: user.id, countedAt: new Date() },
      });
      if (count === 0) throw new NotFoundException({ error: 'COUNT_LINE_NOT_FOUND', message: 'Línea no encontrada' });
    });
    return this.findById(id, user);
  }

  // Products found where nobody expected them; the expected quantity is what the system has now.
  async addLine(id: string, dto: { productId: string; locationId?: string; countedQuantity: number; lotCode?: string }, user: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const count = await this.lockCount(tx, id, user, [CycleCountStatus.open]);
      const product = await tx.product.findFirst({ where: { id: dto.productId, active: true } });
      if (!product) throw new NotFoundException({ error: 'PRODUCT_NOT_FOUND', message: 'Producto no encontrado o inactivo' });
      const existing = await tx.cycleCountLine.findFirst({
        where: { cycleCountId: id, productId: dto.productId, locationId: dto.locationId ?? null },
      });
      if (existing) throw new ConflictException({ error: 'COUNT_LINE_EXISTS', message: 'Ese producto ya está en el conteo para esa ubicación' });

      let expectedQuantity: number;
      if (dto.locationId) {
        const location = await tx.location.findUnique({ where: { id: dto.locationId } });
        if (location?.warehouseId !== count.warehouseId) {
          throw new NotFoundException({ error: 'LOCATION_NOT_FOUND', message: 'Ubicación no encontrada en el almacén' });
        }
        const row = await tx.locationStock.findUnique({ where: { productId_locationId: { productId: dto.productId, locationId: dto.locationId } } });
        expectedQuantity = row?.quantity ?? 0;
      } else {
        expectedQuantity = await this.unlocated(tx, dto.productId, count.warehouseId);
      }
      await tx.cycleCountLine.create({
        data: {
          cycleCountId: id,
          productId: dto.productId,
          locationId: dto.locationId,
          expectedQuantity,
          countedQuantity: dto.countedQuantity,
          lotCode: dto.lotCode?.trim().toUpperCase(),
          countedById: user.id,
          countedAt: new Date(),
        },
      });
    });
    return this.findById(id, user);
  }

  async submit(id: string, user: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      await this.lockCount(tx, id, user, [CycleCountStatus.open]);
      const pending = await tx.cycleCountLine.count({ where: { cycleCountId: id, countedQuantity: null } });
      if (pending > 0) {
        throw new UnprocessableEntityException({ error: 'COUNT_INCOMPLETE', message: `Faltan ${pending} líneas por contar`, details: { pending } });
      }
      await tx.cycleCount.update({ where: { id }, data: { status: CycleCountStatus.submitted, submittedAt: new Date() } });
    });
    return this.findById(id, user);
  }

  async reopen(id: string, user: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      await this.lockCount(tx, id, user, [CycleCountStatus.submitted]);
      await tx.cycleCount.update({ where: { id }, data: { status: CycleCountStatus.open, submittedAt: null } });
    });
    return this.findById(id, user);
  }

  async cancel(id: string, user: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      await this.lockCount(tx, id, user, [CycleCountStatus.open, CycleCountStatus.submitted]);
      await tx.cycleCount.update({ where: { id }, data: { status: CycleCountStatus.cancelled } });
    });
    return this.findById(id, user);
  }

  // Applies counted - expected of every line as adjustments, all or nothing.
  async approve(id: string, user: AuthUser) {
    await this.prisma.$transaction(
      async (tx) => {
        const count = await this.lockCount(tx, id, user, [CycleCountStatus.submitted]);
        const lines = await tx.cycleCountLine.findMany({ where: { cycleCountId: id }, include: { product: true } });
        const changes = lines
          .map((line) => ({ ...line, difference: (line.countedQuantity ?? line.expectedQuantity) - line.expectedQuantity }))
          .filter((line) => line.difference !== 0)
          .sort((a, b) => a.productId.localeCompare(b.productId));

        const missingLot = changes.filter((line) => line.difference > 0 && line.product.lotTracking && !line.lotCode);
        if (missingLot.length > 0) {
          throw new UnprocessableEntityException({
            error: 'LOT_REQUIRED',
            message: 'Indica el lote de las unidades sobrantes de productos con lotes',
            details: missingLot.map((line) => ({ lineId: line.id, product: line.product.code })),
          });
        }

        for (const line of changes) {
          await tx.warehouseStock.upsert({
            where: { productId_warehouseId: { productId: line.productId, warehouseId: count.warehouseId } },
            create: { tenantId: requireTenantId(), productId: line.productId, warehouseId: count.warehouseId },
            update: {},
          });
          const stock = (await lockWarehouseStock(tx, line.productId, count.warehouseId))!;
          await this.adjust(tx, stock, line, count.reference, user);
        }
        await tx.cycleCount.update({
          where: { id },
          data: { status: CycleCountStatus.approved, approvedById: user.id, approvedAt: new Date() },
        });
      },
      { timeout: 60_000 },
    );
    return this.findById(id, user);
  }

  private async adjust(
    tx: Tx,
    stock: WarehouseStock,
    line: { id: string; productId: string; locationId: string | null; lotCode: string | null; difference: number; product: { code: string } },
    reference: string,
    user: AuthUser,
  ) {
    const quantity = Math.abs(line.difference);
    let lotId: string | null | undefined;
    if (line.difference > 0) {
      if (line.locationId) await putAway(tx, stock, line.locationId, quantity);
      lotId = await receiveIntoLot(tx, stock, quantity, line.lotCode ? { code: line.lotCode } : undefined);
    } else {
      const available = stock.onHand - stock.reserved;
      if (available < quantity) {
        throw new ConflictException({
          error: 'INSUFFICIENT_STOCK',
          message: `${line.product.code}: el faltante supera el stock disponible (reservado por pedidos)`,
          details: [{ lineId: line.id, productId: line.productId, requested: quantity, available }],
        });
      }
      if (line.locationId) await takeFromLocation(tx, stock, line.locationId, quantity);
      else await assertUnlocatedAvailable(tx, stock, quantity);
      lotId = singleLot(await takeFromLots(tx, stock, quantity));
    }

    const onHandAfter = stock.onHand + line.difference;
    await tx.warehouseStock.update({ where: { id: stock.id }, data: { onHand: onHandAfter } });
    await tx.stockMovement.create({
      data: {
        tenantId: requireTenantId(),
        productId: line.productId,
        warehouseId: stock.warehouseId,
        type: line.difference > 0 ? 'adjustment_increase' : 'adjustment_decrease',
        quantity,
        onHandBefore: stock.onHand,
        onHandAfter,
        reservedBefore: stock.reserved,
        reservedAfter: stock.reserved,
        referenceType: 'cycle_count',
        referenceId: line.id,
        notes: `Conteo ${reference}`,
        operatorId: user.id,
        operatorName: user.name,
        locationId: line.locationId,
        lotId,
      },
    });
  }

  private async unlocated(tx: Tx, productId: string, warehouseId: string) {
    const stock = await tx.warehouseStock.findUnique({ where: { productId_warehouseId: { productId, warehouseId } } });
    if (!stock) return 0;
    const { _sum } = await tx.locationStock.aggregate({ where: { productId, warehouseId }, _sum: { quantity: true } });
    return stock.onHand - stock.picked - (_sum.quantity ?? 0);
  }

  private async lockCount(tx: Tx, id: string, user: AuthUser, allowed: CycleCountStatus[]) {
    await tx.$queryRaw`SELECT id FROM cycle_counts WHERE id = ${id} AND "tenantId" = ${requireTenantId()} FOR UPDATE`;
    const count = await tx.cycleCount.findUnique({ where: { id } });
    if (!count) throw new NotFoundException(NOT_FOUND);
    assertWarehouseAccess(user, count.warehouseId);
    if (!allowed.includes(count.status)) {
      throw new UnprocessableEntityException({ error: 'COUNT_INVALID_STATUS', message: `El conteo está ${count.status}` });
    }
    return count;
  }
}
