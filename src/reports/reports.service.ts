import { Injectable } from '@nestjs/common';
import { MovementType, OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  INBOUND_MOVEMENT_TYPES,
  OUTBOUND_MOVEMENT_TYPES,
  STOCK_STATUS_CONDITION,
  warehouseCondition,
} from '../stock/stock-status';

type DateRange = { gte?: Date; lte?: Date };
type MovementTotals = { count: number; totalUnits: number };
type StockRow = {
  id: string;
  code: string;
  name: string;
  category: string;
  warehouseId: string;
  stockFisico: number;
  stockReservado: number;
  minStock: number;
  location: string;
};

const ORDER_STATUSES = Object.values(OrderStatus);

function toStockItem(row: StockRow) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    category: row.category,
    warehouseId: row.warehouseId,
    stockFisico: row.stockFisico,
    stockReservado: row.stockReservado,
    stockDisponible: Math.max(0, row.stockFisico - row.stockReservado),
    minStock: row.minStock,
    location: row.location,
  };
}

@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService) {}

  async getDashboard(warehouseId?: string) {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [completedToday, pendingNow, inProgressNow, stockSummary, movementsToday] = await Promise.all([
      this.prisma.pickingOrder.count({
        where: { warehouseId, status: OrderStatus.completed, completedAt: { gte: startOfToday } },
      }),
      this.prisma.pickingOrder.count({ where: { warehouseId, status: OrderStatus.pending } }),
      this.prisma.pickingOrder.count({ where: { warehouseId, status: OrderStatus.in_progress } }),
      this.stockSummary(warehouseId),
      this.movementTotals({ warehouseId, createdAt: { gte: startOfToday } }),
    ]);

    const total = completedToday + pendingNow + inProgressNow;
    return {
      warehouseId: warehouseId ?? null,
      ordersCompletedToday: completedToday,
      ordersPendingNow: pendingNow,
      ordersInProgressNow: inProgressNow,
      efficiencyPercent: total > 0 ? Math.round((completedToday / total) * 100) : 0,
      stockAlerts: {
        outOfStock: stockSummary.outOfStock,
        lowStock: stockSummary.lowStock,
        totalReserved: stockSummary.totalReserved,
      },
      movements: {
        entradasHoy: movementsToday.inbound.count,
        salidasHoy: movementsToday.outbound.count,
        unidadesEntradasHoy: movementsToday.inbound.totalUnits,
        unidadesSalidasHoy: movementsToday.outbound.totalUnits,
      },
    };
  }

  async getPickingStats(warehouseId?: string, from?: string, to?: string) {
    const createdAt = this.dateRange(from, to);
    const where: Prisma.PickingOrderWhereInput = { warehouseId, createdAt };

    const [byStatus, itemCount] = await Promise.all([
      this.prisma.pickingOrder.groupBy({ by: ['status'], where, _count: { _all: true } }),
      this.prisma.pickingItem.count({ where: { pickingOrder: where } }),
    ]);

    const counts = this.countByStatus(byStatus);
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    return {
      warehouseId: warehouseId ?? null,
      total,
      byStatus: counts,
      avgItemsPerOrder: total > 0 ? Math.round((itemCount / total) * 10) / 10 : 0,
    };
  }

  async getPackingStats(warehouseId?: string, from?: string, to?: string) {
    const byStatus = await this.prisma.packingOrder.groupBy({
      by: ['status'],
      where: { warehouseId, createdAt: this.dateRange(from, to) },
      _count: { _all: true },
    });

    const counts = this.countByStatus(byStatus);
    return {
      warehouseId: warehouseId ?? null,
      total: Object.values(counts).reduce((sum, n) => sum + n, 0),
      byStatus: counts,
    };
  }

  async getStockStatus(warehouseId?: string) {
    const [summary, outOfStock, lowStock] = await Promise.all([
      this.stockSummary(warehouseId),
      this.stockRows(warehouseId, STOCK_STATUS_CONDITION.out),
      this.stockRows(warehouseId, STOCK_STATUS_CONDITION.low),
    ]);

    return {
      warehouseId: warehouseId ?? null,
      summary: {
        total: summary.total,
        outOfStock: summary.outOfStock,
        lowStock: summary.lowStock,
        ok: summary.ok,
      },
      outOfStock: outOfStock.map(toStockItem),
      lowStock: lowStock.map(toStockItem),
    };
  }

  async getStockMovementsSummary(warehouseId?: string, from?: string, to?: string) {
    const totals = await this.movementTotals({ warehouseId, createdAt: this.dateRange(from, to) });
    return {
      warehouseId: warehouseId ?? null,
      period: { from: from ?? null, to: to ?? null },
      entradas: totals.inbound,
      salidas: totals.outbound,
      byType: totals.byType,
    };
  }

  private async stockSummary(warehouseId?: string) {
    const [row] = await this.prisma.$queryRaw<
      { total: number; outOfStock: number; lowStock: number; ok: number; totalReserved: number }[]
    >`
      SELECT
        count(*)::int AS "total",
        count(*) FILTER (WHERE ${STOCK_STATUS_CONDITION.out})::int AS "outOfStock",
        count(*) FILTER (WHERE ${STOCK_STATUS_CONDITION.low})::int AS "lowStock",
        count(*) FILTER (WHERE ${STOCK_STATUS_CONDITION.ok})::int AS "ok",
        coalesce(sum(ws."stockReservado"), 0)::int AS "totalReserved"
      FROM warehouse_stock ws
      JOIN products p ON p.id = ws."productId" AND p.active
      WHERE ${warehouseCondition(warehouseId)}`;
    return row;
  }

  private stockRows(warehouseId: string | undefined, condition: Prisma.Sql) {
    return this.prisma.$queryRaw<StockRow[]>`
      SELECT p.id, p.code, p.name, p.category, ws."warehouseId",
             ws."stockFisico", ws."stockReservado", ws."minStock", ws.location
      FROM warehouse_stock ws
      JOIN products p ON p.id = ws."productId" AND p.active
      WHERE ${warehouseCondition(warehouseId)} AND ${condition}
      ORDER BY (ws."stockFisico" - ws."stockReservado"), p.name`;
  }

  private async movementTotals(where: Prisma.StockMovementWhereInput) {
    const groups = await this.prisma.stockMovement.groupBy({
      by: ['type'],
      where,
      _count: { _all: true },
      _sum: { quantity: true },
    });

    const byType: Partial<Record<MovementType, MovementTotals>> = {};
    const inbound: MovementTotals = { count: 0, totalUnits: 0 };
    const outbound: MovementTotals = { count: 0, totalUnits: 0 };

    for (const group of groups) {
      const totals = { count: group._count._all, totalUnits: group._sum.quantity ?? 0 };
      byType[group.type] = totals;
      const bucket = INBOUND_MOVEMENT_TYPES.includes(group.type)
        ? inbound
        : OUTBOUND_MOVEMENT_TYPES.includes(group.type)
          ? outbound
          : null;
      if (bucket) {
        bucket.count += totals.count;
        bucket.totalUnits += totals.totalUnits;
      }
    }

    return { inbound, outbound, byType };
  }

  private countByStatus(groups: { status: OrderStatus; _count: { _all: number } }[]) {
    const counts = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0])) as Record<OrderStatus, number>;
    for (const group of groups) counts[group.status] = group._count._all;
    return counts;
  }

  private dateRange(from?: string, to?: string): DateRange | undefined {
    if (!from && !to) return undefined;
    return { ...(from && { gte: new Date(from) }), ...(to && { lte: new Date(to) }) };
  }
}
