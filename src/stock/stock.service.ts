import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MovementType } from '@prisma/client';
import { paginate, buildMeta } from '../common/dto/pagination.dto';
import { NotificationsService } from '../notifications/notifications.service';
import { ActivityService } from '../activity/activity.service';

@Injectable()
export class StockService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private activity: ActivityService,
  ) {}

  async registerMovement(opts: {
    productId: string;
    warehouseId: string;
    type: MovementType;
    quantity: number;
    notes?: string;
    referenceType?: string;
    referenceId?: string;
    operatorId: string;
    operatorName: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const stock = await tx.warehouseStock.findUnique({
        where: { productId_warehouseId: { productId: opts.productId, warehouseId: opts.warehouseId } },
      });
      if (!stock) throw new NotFoundException({ error: 'PRODUCT_NOT_FOUND', message: 'El producto no existe en este almacén' });

      const { stockFisico, stockReservado } = stock;
      let newFisico = stockFisico;
      let newReservado = stockReservado;

      const isDecrease = ['ajuste_negativo', 'salida_traslado'].includes(opts.type);
      const isIncrease = ['entrada_compra', 'entrada_devolucion', 'entrada_traslado', 'inventario_inicial', 'ajuste_positivo'].includes(opts.type);

      if (isIncrease) newFisico += opts.quantity;
      if (isDecrease) {
        const disponible = stockFisico - stockReservado;
        if (disponible < opts.quantity) {
          throw new ConflictException({
            error: 'STOCK_INSUFICIENTE',
            message: `Stock disponible insuficiente para completar la operación`,
            details: [{ productId: opts.productId, requested: opts.quantity, available: disponible }],
          });
        }
        newFisico -= opts.quantity;
      }

      const [movement] = await Promise.all([
        tx.stockMovement.create({
          data: {
            productId: opts.productId,
            warehouseId: opts.warehouseId,
            type: opts.type,
            quantity: opts.quantity,
            stockFisicoAntes: stockFisico,
            stockFisicoDespues: newFisico,
            stockReservadoAntes: stockReservado,
            stockReservadoDespues: newReservado,
            referenceType: opts.referenceType,
            referenceId: opts.referenceId,
            notes: opts.notes,
            operatorId: opts.operatorId,
            operatorName: opts.operatorName,
          },
        }),
        tx.warehouseStock.update({
          where: { productId_warehouseId: { productId: opts.productId, warehouseId: opts.warehouseId } },
          data: { stockFisico: newFisico, stockReservado: newReservado },
        }),
      ]);

      return {
        movement,
        stockActual: {
          stockFisico: newFisico,
          stockReservado: newReservado,
          stockDisponible: newFisico - newReservado,
        },
      };
    });
  }

  async transfer(opts: {
    productId: string;
    fromWarehouseId: string;
    toWarehouseId: string;
    quantity: number;
    notes?: string;
    operatorId: string;
    operatorName: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const fromStock = await tx.warehouseStock.findUnique({
        where: { productId_warehouseId: { productId: opts.productId, warehouseId: opts.fromWarehouseId } },
      });
      if (!fromStock) throw new NotFoundException({ error: 'PRODUCT_NOT_FOUND', message: 'El producto no existe en el almacén origen' });

      const disponible = fromStock.stockFisico - fromStock.stockReservado;
      if (disponible < opts.quantity) {
        throw new ConflictException({
          error: 'STOCK_INSUFICIENTE',
          message: `Disponible en almacén origen: ${disponible}. Solicitado: ${opts.quantity}.`,
          details: [{ productId: opts.productId, requested: opts.quantity, available: disponible }],
        });
      }

      const toStock = await tx.warehouseStock.findUnique({
        where: { productId_warehouseId: { productId: opts.productId, warehouseId: opts.toWarehouseId } },
      });

      const newFromFisico = fromStock.stockFisico - opts.quantity;
      const newToFisico = (toStock?.stockFisico ?? 0) + opts.quantity;

      const [outMov, inMov] = await Promise.all([
        tx.stockMovement.create({
          data: {
            productId: opts.productId,
            warehouseId: opts.fromWarehouseId,
            type: 'salida_traslado',
            quantity: opts.quantity,
            stockFisicoAntes: fromStock.stockFisico,
            stockFisicoDespues: newFromFisico,
            stockReservadoAntes: fromStock.stockReservado,
            stockReservadoDespues: fromStock.stockReservado,
            notes: opts.notes,
            operatorId: opts.operatorId,
            operatorName: opts.operatorName,
          },
        }),
        tx.stockMovement.create({
          data: {
            productId: opts.productId,
            warehouseId: opts.toWarehouseId,
            type: 'entrada_traslado',
            quantity: opts.quantity,
            stockFisicoAntes: toStock?.stockFisico ?? 0,
            stockFisicoDespues: newToFisico,
            stockReservadoAntes: toStock?.stockReservado ?? 0,
            stockReservadoDespues: toStock?.stockReservado ?? 0,
            notes: opts.notes,
            operatorId: opts.operatorId,
            operatorName: opts.operatorName,
          },
        }),
        tx.warehouseStock.update({
          where: { productId_warehouseId: { productId: opts.productId, warehouseId: opts.fromWarehouseId } },
          data: { stockFisico: newFromFisico },
        }),
        toStock
          ? tx.warehouseStock.update({
              where: { productId_warehouseId: { productId: opts.productId, warehouseId: opts.toWarehouseId } },
              data: { stockFisico: newToFisico },
            })
          : tx.warehouseStock.create({
              data: {
                productId: opts.productId,
                warehouseId: opts.toWarehouseId,
                stockFisico: opts.quantity,
              },
            }),
      ]);

      return { movements: [outMov, inMov] };
    });
  }

  async findMovements(opts: {
    productId?: string;
    warehouseId?: string;
    type?: MovementType;
    dateFrom?: string;
    dateTo?: string;
    page: number;
    limit: number;
  }) {
    const where: any = {};
    if (opts.productId) where.productId = opts.productId;
    if (opts.warehouseId) where.warehouseId = opts.warehouseId;
    if (opts.type) where.type = opts.type;
    if (opts.dateFrom || opts.dateTo) {
      where.createdAt = {};
      if (opts.dateFrom) where.createdAt.gte = new Date(opts.dateFrom);
      if (opts.dateTo) where.createdAt.lte = new Date(opts.dateTo);
    }

    const [data, total] = await Promise.all([
      this.prisma.stockMovement.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...paginate(opts.page, opts.limit),
      }),
      this.prisma.stockMovement.count({ where }),
    ]);

    return { data, meta: buildMeta(total, opts.page, opts.limit) };
  }
}
