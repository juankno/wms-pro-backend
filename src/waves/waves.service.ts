import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { OrderStatus, Prisma, Priority, WaveStatus } from '@prisma/client';
import { buildMeta, paginate } from '../common/dto/pagination.dto';
import { AuthUser } from '../common/types/request-with-user.interface';
import { assertWarehouseAccess } from '../common/utils/warehouse-scope';
import { PickingService } from '../picking/picking.service';
import { PrismaService } from '../prisma/prisma.service';
import { nextReference } from '../sequences/sequence';
import { requireTenantId } from '../tenancy/tenant-context';

type Tx = Prisma.TransactionClient;

const WAVEABLE_STATUSES: OrderStatus[] = [OrderStatus.pending, OrderStatus.in_progress];
const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
const NO_ROUTE = Number.MAX_SAFE_INTEGER;

// Products without stocked locations go last.
const routeOrder = (row: { locations: { pickSequence: number }[] }) => row.locations[0]?.pickSequence ?? NO_ROUTE;

const WAVE_INCLUDE = {
  warehouse: { select: { id: true, code: true, name: true } },
  assignedTo: { select: { id: true, name: true } },
  pickingOrders: {
    select: { id: true, reference: true, client: true, status: true, priority: true, items: { select: { quantity: true, pickedQuantity: true } } },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.PickingWaveInclude;

const NOT_FOUND = { error: 'WAVE_NOT_FOUND', message: 'Ola no encontrada' };

// Orders served first when a picked quantity is split: higher priority, then older.
const byServiceOrder = (a: { priority: Priority; createdAt: Date }, b: { priority: Priority; createdAt: Date }) =>
  PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.createdAt.getTime() - b.createdAt.getTime();

@Injectable()
export class WavesService {
  constructor(
    private prisma: PrismaService,
    private picking: PickingService,
  ) {}

  async findAll(opts: { status?: WaveStatus; warehouseId?: string; page: number; limit: number }) {
    const where: Prisma.PickingWaveWhereInput = { status: opts.status, warehouseId: opts.warehouseId };
    const [data, total] = await Promise.all([
      this.prisma.pickingWave.findMany({ where, include: WAVE_INCLUDE, orderBy: { createdAt: 'desc' }, ...paginate(opts.page, opts.limit) }),
      this.prisma.pickingWave.count({ where }),
    ]);
    return { data, meta: buildMeta(total, opts.page, opts.limit) };
  }

  async findById(id: string, user: AuthUser) {
    const wave = await this.prisma.pickingWave.findUnique({ where: { id }, include: WAVE_INCLUDE });
    if (!wave) throw new NotFoundException(NOT_FOUND);
    assertWarehouseAccess(user, wave.warehouseId);
    return wave;
  }

  async create(dto: { pickingOrderIds: string[]; assignedToId?: string }, user: AuthUser) {
    const wave = await this.prisma.$transaction(async (tx) => {
      const orders = await tx.pickingOrder.findMany({ where: { id: { in: dto.pickingOrderIds } } });
      if (orders.length !== new Set(dto.pickingOrderIds).size) {
        throw new NotFoundException({ error: 'ORDER_NOT_FOUND', message: 'Alguna orden de picking no existe' });
      }
      const warehouseIds = new Set(orders.map((order) => order.warehouseId));
      if (warehouseIds.size > 1) {
        throw new UnprocessableEntityException({ error: 'MIXED_WAREHOUSES', message: 'Las órdenes de una ola deben ser del mismo almacén' });
      }
      const [warehouseId] = warehouseIds;
      assertWarehouseAccess(user, warehouseId);
      const invalid = orders.filter((order) => !WAVEABLE_STATUSES.includes(order.status) || order.waveId);
      if (invalid.length > 0) {
        throw new UnprocessableEntityException({
          error: 'ORDER_NOT_WAVEABLE',
          message: 'Solo se agrupan órdenes pendientes o en curso que no estén en otra ola',
          details: invalid.map((order) => order.reference),
        });
      }

      const reference = await nextReference(tx, 'wave', async (candidate) => !!(await tx.pickingWave.findFirst({ where: { reference: candidate } })));
      const created = await tx.pickingWave.create({
        data: { tenantId: requireTenantId(), reference, warehouseId, assignedToId: dto.assignedToId, createdById: user.id },
      });
      await tx.pickingOrder.updateMany({
        where: { id: { in: dto.pickingOrderIds } },
        data: { waveId: created.id, ...(dto.assignedToId && { assignedToId: dto.assignedToId }) },
      });
      return created;
    });
    return this.findById(wave.id, user);
  }

  // One row per product in walking order (first stocked location), with how each order shares it.
  async pickList(id: string, user: AuthUser) {
    const wave = await this.findById(id, user);
    const items = await this.prisma.pickingItem.findMany({
      where: { pickingOrder: { waveId: id, status: { in: WAVEABLE_STATUSES } } },
      include: { pickingOrder: { select: { id: true, reference: true, priority: true, createdAt: true } } },
    });
    const productIds = [...new Set(items.map((item) => item.productId))];
    const stocked = await this.prisma.locationStock.findMany({
      where: { warehouseId: wave.warehouseId, productId: { in: productIds }, quantity: { gt: 0 } },
      include: { location: { select: { id: true, code: true, pickSequence: true } } },
    });

    return productIds
      .map((productId) => {
        const lines = items.filter((item) => item.productId === productId).sort((a, b) => byServiceOrder(a.pickingOrder, b.pickingOrder));
        const locations = stocked
          .filter((row) => row.productId === productId)
          .sort((a, b) => a.location.pickSequence - b.location.pickSequence || a.location.code.localeCompare(b.location.code))
          .map((row) => ({ ...row.location, quantity: row.quantity }));
        const quantity = lines.reduce((sum, line) => sum + line.quantity, 0);
        const picked = lines.reduce((sum, line) => sum + line.pickedQuantity, 0);
        return {
          productId,
          productCode: lines[0].productCode,
          productName: lines[0].productName,
          unit: lines[0].unit,
          quantity,
          picked,
          remaining: quantity - picked,
          locations,
          orders: lines.map((line) => ({
            pickingOrderId: line.pickingOrder.id,
            reference: line.pickingOrder.reference,
            itemId: line.id,
            quantity: line.quantity,
            picked: line.pickedQuantity,
          })),
        };
      })
      .sort((a, b) => routeOrder(a) - routeOrder(b) || a.productCode.localeCompare(b.productCode));
  }

  // Spreads one picked quantity over the wave's orders, all or nothing.
  async pick(id: string, dto: { productId: string; quantity: number; locationId?: string; lotId?: string }, user: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const wave = await this.lockOpenWave(tx, id, user);
      const items = await tx.pickingItem.findMany({
        where: { productId: dto.productId, pickingOrder: { waveId: wave.id, status: { in: WAVEABLE_STATUSES } } },
        include: { pickingOrder: { select: { id: true, priority: true, createdAt: true } } },
      });
      items.sort((a, b) => byServiceOrder(a.pickingOrder, b.pickingOrder));

      let left = dto.quantity;
      for (const item of items) {
        if (left === 0) break;
        const take = Math.min(item.quantity - item.pickedQuantity, left);
        if (take <= 0) continue;
        await this.picking.updateItemInTransaction(tx, item.pickingOrder.id, item.id, item.pickedQuantity + take, user, dto.locationId, dto.lotId);
        left -= take;
      }
      if (left > 0) {
        throw new UnprocessableEntityException({
          error: 'QUANTITY_EXCEEDED',
          message: `Sobran ${left} unidades: la ola no necesita tantas de este producto`,
        });
      }
    });
    return (await this.pickList(id, user)).find((row) => row.productId === dto.productId);
  }

  // Closes the wave: orders with picked units are completed, untouched ones leave the wave.
  async complete(id: string, user: AuthUser) {
    const wave = await this.findById(id, user);
    if (wave.status !== WaveStatus.open) throw this.notOpen(wave.status);
    for (const order of wave.pickingOrders) {
      if (!WAVEABLE_STATUSES.includes(order.status)) continue;
      if (!order.items.some((item) => item.pickedQuantity > 0)) {
        await this.prisma.pickingOrder.update({ where: { id: order.id }, data: { waveId: null } });
        continue;
      }
      if (order.status === OrderStatus.pending) await this.picking.updateStatus(order.id, OrderStatus.in_progress, user);
      await this.picking.updateStatus(order.id, OrderStatus.completed, user);
    }
    await this.prisma.pickingWave.update({ where: { id }, data: { status: WaveStatus.completed, completedAt: new Date() } });
    return this.findById(id, user);
  }

  // Dissolves the wave; its orders keep their progress and can be picked one by one.
  async cancel(id: string, user: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      await this.lockOpenWave(tx, id, user);
      await tx.pickingOrder.updateMany({ where: { waveId: id }, data: { waveId: null } });
      await tx.pickingWave.update({ where: { id }, data: { status: WaveStatus.cancelled } });
    });
    return this.findById(id, user);
  }

  private async lockOpenWave(tx: Tx, id: string, user: AuthUser) {
    await tx.$queryRaw`SELECT id FROM picking_waves WHERE id = ${id} AND "tenantId" = ${requireTenantId()} FOR UPDATE`;
    const wave = await tx.pickingWave.findUnique({ where: { id } });
    if (!wave) throw new NotFoundException(NOT_FOUND);
    assertWarehouseAccess(user, wave.warehouseId);
    if (wave.status !== WaveStatus.open) throw this.notOpen(wave.status);
    return wave;
  }

  private notOpen(status: WaveStatus) {
    return new UnprocessableEntityException({ error: 'WAVE_NOT_OPEN', message: `La ola está ${status}` });
  }
}
