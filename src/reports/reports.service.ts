import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService) {}

  async getDashboard(warehouseId: string) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [
      ordersCompletedToday,
      ordersPendingNow,
      ordersInProgressNow,
      stockAlerts,
      movementsToday,
    ] = await Promise.all([
      this.prisma.pickingOrder.count({ where: { warehouseId, status: 'completed', completedAt: { gte: today } } }),
      this.prisma.pickingOrder.count({ where: { warehouseId, status: 'pending' } }),
      this.prisma.pickingOrder.count({ where: { warehouseId, status: 'in_progress' } }),
      this.prisma.warehouseStock.findMany({ where: { warehouseId } }),
      this.prisma.stockMovement.findMany({ where: { warehouseId, createdAt: { gte: today } } }),
    ]);

    const outOfStock = stockAlerts.filter((s) => s.stockFisico - s.stockReservado === 0).length;
    const lowStock = stockAlerts.filter((s) => {
      const avail = s.stockFisico - s.stockReservado;
      return avail > 0 && avail <= s.minStock;
    }).length;
    const totalReserved = stockAlerts.reduce((acc, s) => acc + s.stockReservado, 0);

    const entradas = movementsToday.filter((m) => m.type.startsWith('entrada_'));
    const salidas = movementsToday.filter((m) => m.type.startsWith('salida_'));

    const total = ordersCompletedToday + ordersPendingNow + ordersInProgressNow;
    const efficiencyPercent = total > 0 ? Math.round((ordersCompletedToday / total) * 100) : 0;

    return {
      warehouseId,
      ordersCompletedToday,
      ordersPendingNow,
      ordersInProgressNow,
      efficiencyPercent,
      stockAlerts: { outOfStock, lowStock, totalReserved },
      movements: {
        entradasHoy: entradas.length,
        salidasHoy: salidas.length,
        unidadesEntradasHoy: entradas.reduce((a, m) => a + m.quantity, 0),
        unidadesSalidasHoy: salidas.reduce((a, m) => a + m.quantity, 0),
      },
    };
  }

  async getStock(warehouseId: string) {
    return this.prisma.warehouseStock.findMany({
      where: { warehouseId },
      include: { product: { select: { id: true, code: true, name: true, category: true, unit: true } } },
    });
  }

  async getPickingStats(warehouseId: string, from?: string, to?: string) {
    const dateFilter = this.buildDateFilter(from, to);
    const where: any = { warehouseId, ...(dateFilter ? { createdAt: dateFilter } : {}) };

    const [total, byStatus, avgItemsRaw] = await Promise.all([
      this.prisma.pickingOrder.count({ where }),
      this.prisma.pickingOrder.groupBy({ by: ['status'], where, _count: { id: true } }),
      this.prisma.pickingItem.aggregate({ where: { pickingOrder: { warehouseId } }, _avg: { quantity: true } }),
    ]);

    const statusMap = Object.fromEntries(byStatus.map((s) => [s.status, s._count.id]));
    return {
      warehouseId,
      total,
      byStatus: {
        pending: statusMap['pending'] ?? 0,
        in_progress: statusMap['in_progress'] ?? 0,
        completed: statusMap['completed'] ?? 0,
        cancelled: statusMap['cancelled'] ?? 0,
      },
      avgItemsPerOrder: Math.round((avgItemsRaw._avg.quantity ?? 0) * 10) / 10,
    };
  }

  async getPackingStats(warehouseId: string, from?: string, to?: string) {
    const dateFilter = this.buildDateFilter(from, to);
    const where: any = { warehouseId, ...(dateFilter ? { createdAt: dateFilter } : {}) };

    const [total, byStatus] = await Promise.all([
      this.prisma.packingOrder.count({ where }),
      this.prisma.packingOrder.groupBy({ by: ['status'], where, _count: { id: true } }),
    ]);

    const statusMap = Object.fromEntries(byStatus.map((s) => [s.status, s._count.id]));
    return {
      warehouseId,
      total,
      byStatus: {
        pending: statusMap['pending'] ?? 0,
        in_progress: statusMap['in_progress'] ?? 0,
        completed: statusMap['completed'] ?? 0,
        cancelled: statusMap['cancelled'] ?? 0,
      },
    };
  }

  async getStockStatus(warehouseId: string) {
    const stocks = await this.prisma.warehouseStock.findMany({
      where: { warehouseId },
      include: { product: { select: { id: true, code: true, name: true, category: true, active: true } } },
      orderBy: { stockFisico: 'asc' },
    });

    const active = stocks.filter((s) => s.product.active);
    const outOfStock = active.filter((s) => s.stockFisico === 0);
    const lowStock = active.filter((s) => s.stockFisico > 0 && s.stockFisico - s.stockReservado <= s.minStock);
    const ok = active.filter((s) => s.stockFisico - s.stockReservado > s.minStock);

    const mapItem = (s: typeof active[number]) => ({
      ...s.product,
      stockFisico: s.stockFisico,
      stockReservado: s.stockReservado,
      stockDisponible: Math.max(0, s.stockFisico - s.stockReservado),
      minStock: s.minStock,
      location: s.location,
    });

    return {
      warehouseId,
      summary: { total: active.length, outOfStock: outOfStock.length, lowStock: lowStock.length, ok: ok.length },
      outOfStock: outOfStock.map(mapItem),
      lowStock: lowStock.map(mapItem),
    };
  }

  async getStockMovementsSummary(warehouseId: string, from?: string, to?: string) {
    const dateFilter = this.buildDateFilter(from, to);
    const where: any = { warehouseId, ...(dateFilter ? { createdAt: dateFilter } : {}) };

    const movements = await this.prisma.stockMovement.findMany({ where });

    const entradaTypes = ['entrada_compra', 'entrada_devolucion', 'entrada_traslado', 'inventario_inicial', 'ajuste_positivo'];
    const salidaTypes = ['salida_picking', 'salida_traslado', 'ajuste_negativo'];

    const entradas = movements.filter((m) => entradaTypes.includes(m.type));
    const salidas = movements.filter((m) => salidaTypes.includes(m.type));

    const byType = movements.reduce<Record<string, { count: number; totalUnits: number }>>((acc, m) => {
      if (!acc[m.type]) acc[m.type] = { count: 0, totalUnits: 0 };
      acc[m.type].count++;
      acc[m.type].totalUnits += m.quantity;
      return acc;
    }, {});

    return {
      warehouseId,
      period: { from: from ?? null, to: to ?? null },
      entradas: { count: entradas.length, totalUnits: entradas.reduce((s, m) => s + m.quantity, 0) },
      salidas: { count: salidas.length, totalUnits: salidas.reduce((s, m) => s + m.quantity, 0) },
      byType,
    };
  }

  private buildDateFilter(from?: string, to?: string) {
    if (!from && !to) return null;
    const filter: { gte?: Date; lte?: Date } = {};
    if (from) filter.gte = new Date(from);
    if (to) filter.lte = new Date(to);
    return filter;
  }
}
