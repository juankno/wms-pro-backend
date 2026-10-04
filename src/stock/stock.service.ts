import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MovementType, Prisma, WarehouseStock } from '@prisma/client';
import { paginate, buildMeta } from '../common/dto/pagination.dto';
import { ManualMovementType } from './dto/create-movement.dto';
import { lockWarehouseStock } from './stock-lock';

@Injectable()
export class StockService {
  constructor(private prisma: PrismaService) {}

  async registerMovement(opts: {
    productId: string;
    warehouseId: string;
    type: ManualMovementType;
    quantity: number;
    notes?: string;
    referenceType?: string;
    referenceId?: string;
    operatorId: string;
    operatorName: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const stock = await lockWarehouseStock(tx, opts.productId, opts.warehouseId);
      if (!stock) throw new NotFoundException({ error: 'PRODUCT_NOT_FOUND', message: 'El producto no existe en este almacén' });

      const { stockFisico, stockReservado } = stock;
      const isDecrease = opts.type === 'adjustment_decrease';

      if (isDecrease) {
        const disponible = stockFisico - stockReservado;
        if (disponible < opts.quantity) {
          throw new ConflictException({
            error: 'STOCK_INSUFICIENTE',
            message: `Stock disponible insuficiente para completar la operación`,
            details: [{ productId: opts.productId, requested: opts.quantity, available: disponible }],
          });
        }
      }

      const newFisico = isDecrease ? stockFisico - opts.quantity : stockFisico + opts.quantity;

      await tx.warehouseStock.update({
        where: { id: stock.id },
        data: { stockFisico: newFisico },
      });

      const movement = await tx.stockMovement.create({
        data: {
          productId: opts.productId,
          warehouseId: opts.warehouseId,
          type: opts.type,
          quantity: opts.quantity,
          stockFisicoAntes: stockFisico,
          stockFisicoDespues: newFisico,
          stockReservadoAntes: stockReservado,
          stockReservadoDespues: stockReservado,
          referenceType: opts.referenceType,
          referenceId: opts.referenceId,
          notes: opts.notes,
          operatorId: opts.operatorId,
          operatorName: opts.operatorName,
        },
      });

      return {
        movement,
        stockActual: {
          stockFisico: newFisico,
          stockReservado,
          stockDisponible: newFisico - stockReservado,
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
    if (opts.fromWarehouseId === opts.toWarehouseId) {
      throw new BadRequestException({ error: 'SAME_WAREHOUSE', message: 'El almacén origen y destino deben ser distintos' });
    }

    return this.prisma.$transaction(async (tx) => {
      const destination = await tx.warehouse.findUnique({ where: { id: opts.toWarehouseId } });
      if (!destination || !destination.active) {
        throw new NotFoundException({ error: 'WAREHOUSE_NOT_FOUND', message: 'El almacén destino no existe o está inactivo' });
      }

      const origin = await tx.warehouseStock.findUnique({
        where: { productId_warehouseId: { productId: opts.productId, warehouseId: opts.fromWarehouseId } },
        select: { id: true },
      });
      if (!origin) throw new NotFoundException({ error: 'PRODUCT_NOT_FOUND', message: 'El producto no existe en el almacén origen' });

      await tx.$executeRaw`
        INSERT INTO warehouse_stock (id, "productId", "warehouseId")
        VALUES (gen_random_uuid()::text, ${opts.productId}, ${opts.toWarehouseId})
        ON CONFLICT ("productId", "warehouseId") DO NOTHING`;

      // Lock in a deterministic order so opposite-direction transfers cannot deadlock.
      const locked = new Map<string, WarehouseStock>();
      for (const warehouseId of [opts.fromWarehouseId, opts.toWarehouseId].sort()) {
        locked.set(warehouseId, (await lockWarehouseStock(tx, opts.productId, warehouseId))!);
      }
      const fromStock = locked.get(opts.fromWarehouseId)!;
      const toStock = locked.get(opts.toWarehouseId)!;

      const disponible = fromStock.stockFisico - fromStock.stockReservado;
      if (disponible < opts.quantity) {
        throw new ConflictException({
          error: 'STOCK_INSUFICIENTE',
          message: `Disponible en almacén origen: ${disponible}. Solicitado: ${opts.quantity}.`,
          details: [{ productId: opts.productId, requested: opts.quantity, available: disponible }],
        });
      }

      const newFromFisico = fromStock.stockFisico - opts.quantity;
      const newToFisico = toStock.stockFisico + opts.quantity;

      await tx.warehouseStock.update({ where: { id: fromStock.id }, data: { stockFisico: newFromFisico } });
      await tx.warehouseStock.update({ where: { id: toStock.id }, data: { stockFisico: newToFisico } });

      const outMov = await tx.stockMovement.create({
        data: {
          productId: opts.productId,
          warehouseId: opts.fromWarehouseId,
          type: 'transfer_out',
          quantity: opts.quantity,
          stockFisicoAntes: fromStock.stockFisico,
          stockFisicoDespues: newFromFisico,
          stockReservadoAntes: fromStock.stockReservado,
          stockReservadoDespues: fromStock.stockReservado,
          referenceType: 'transfer',
          notes: opts.notes,
          operatorId: opts.operatorId,
          operatorName: opts.operatorName,
        },
      });
      const inMov = await tx.stockMovement.create({
        data: {
          productId: opts.productId,
          warehouseId: opts.toWarehouseId,
          type: 'transfer_in',
          quantity: opts.quantity,
          stockFisicoAntes: toStock.stockFisico,
          stockFisicoDespues: newToFisico,
          stockReservadoAntes: toStock.stockReservado,
          stockReservadoDespues: toStock.stockReservado,
          referenceType: 'transfer',
          referenceId: outMov.id,
          notes: opts.notes,
          operatorId: opts.operatorId,
          operatorName: opts.operatorName,
        },
      });

      return { movements: [outMov, inMov] };
    });
  }

  async updateStockSettings(opts: {
    productId: string;
    warehouseId: string;
    location?: string | null;
    minStock?: number;
  }) {
    try {
      return await this.prisma.warehouseStock.update({
        where: { productId_warehouseId: { productId: opts.productId, warehouseId: opts.warehouseId } },
        data: {
          ...(opts.location !== undefined && { location: opts.location ?? '' }),
          ...(opts.minStock !== undefined && { minStock: opts.minStock }),
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException({ error: 'STOCK_NOT_FOUND', message: 'El producto no tiene stock registrado en este almacén' });
      }
      throw e;
    }
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
    const where: Prisma.StockMovementWhereInput = {};
    if (opts.productId) where.productId = opts.productId;
    if (opts.warehouseId) where.warehouseId = opts.warehouseId;
    if (opts.type) where.type = opts.type;
    if (opts.dateFrom || opts.dateTo) {
      where.createdAt = {
        ...(opts.dateFrom && { gte: new Date(opts.dateFrom) }),
        ...(opts.dateTo && { lte: new Date(opts.dateTo) }),
      };
    }

    const [data, total] = await Promise.all([
      this.prisma.stockMovement.findMany({
        where,
        include: {
          product: { select: { id: true, code: true, name: true } },
          warehouse: { select: { id: true, code: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        ...paginate(opts.page, opts.limit),
      }),
      this.prisma.stockMovement.count({ where }),
    ]);

    return { data, meta: buildMeta(total, opts.page, opts.limit) };
  }
}
