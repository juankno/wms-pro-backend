import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { buildMeta, paginate } from '../common/dto/pagination.dto';
import { PrismaService } from '../prisma/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const TRACE_MOVEMENTS = 100;

@Injectable()
export class LotsService {
  constructor(private prisma: PrismaService) {}

  // `warehouseId` limits both which lots appear (those with stock there) and the balances shown.
  async findAll(opts: {
    productId?: string;
    warehouseId?: string;
    search?: string;
    expiringWithinDays?: number;
    page: number;
    limit: number;
  }) {
    const stockFilter: Prisma.LotStockWhereInput = { quantity: { gt: 0 }, warehouseId: opts.warehouseId };
    const where: Prisma.LotWhereInput = {
      productId: opts.productId,
      stock: { some: stockFilter },
      ...(opts.search && { code: { contains: opts.search, mode: 'insensitive' } }),
      ...(opts.expiringWithinDays !== undefined && {
        expiresAt: { lte: new Date(Date.now() + opts.expiringWithinDays * DAY_MS) },
      }),
    };
    const [data, total] = await Promise.all([
      this.prisma.lot.findMany({
        where,
        include: {
          product: { select: { id: true, code: true, name: true, unit: true } },
          stock: { where: stockFilter, include: { warehouse: { select: { id: true, code: true, name: true } } } },
        },
        orderBy: [{ expiresAt: { sort: 'asc', nulls: 'last' } }, { code: 'asc' }],
        ...paginate(opts.page, opts.limit),
      }),
      this.prisma.lot.count({ where }),
    ]);
    return { data, meta: buildMeta(total, opts.page, opts.limit) };
  }

  // Where the lot is, how it moved and which orders shipped it.
  async trace(id: string, warehouseId?: string) {
    const lot = await this.prisma.lot.findUnique({
      where: { id },
      include: { product: { select: { id: true, code: true, name: true, unit: true } } },
    });
    if (!lot) throw new NotFoundException({ error: 'LOT_NOT_FOUND', message: 'Lote no encontrado' });

    const [stock, movements, picks] = await Promise.all([
      this.prisma.lotStock.findMany({
        where: { lotId: id, warehouseId, quantity: { gt: 0 } },
        include: { warehouse: { select: { id: true, code: true, name: true } } },
      }),
      this.prisma.stockMovement.findMany({
        where: { lotId: id, warehouseId },
        include: { warehouse: { select: { id: true, code: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        take: TRACE_MOVEMENTS,
      }),
      this.prisma.pickingItemLot.findMany({
        where: { lotId: id, quantity: { gt: 0 }, pickingItem: { pickingOrder: { warehouseId } } },
        include: {
          pickingItem: {
            select: {
              pickingOrder: {
                select: { id: true, reference: true, client: true, status: true, warehouseId: true, completedAt: true },
              },
            },
          },
        },
      }),
    ]);

    return {
      ...lot,
      stock: stock.map(({ warehouse, quantity }) => ({ warehouse, quantity })),
      movements,
      orders: picks.map((pick) => ({ ...pick.pickingItem.pickingOrder, quantity: pick.quantity })),
    };
  }
}
