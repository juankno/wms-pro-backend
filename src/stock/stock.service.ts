import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MovementType, Prisma, WarehouseStock } from '@prisma/client';
import { paginate, buildMeta } from '../common/dto/pagination.dto';
import { ManualMovementType } from './dto/create-movement.dto';
import { lockWarehouseStock } from './stock-lock';
import { requireTenantId } from '../tenancy/tenant-context';

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

      const { onHand, reserved } = stock;
      const isDecrease = opts.type === 'adjustment_decrease';

      if (isDecrease) {
        const available = onHand - reserved;
        if (available < opts.quantity) {
          throw new ConflictException({
            error: 'INSUFFICIENT_STOCK',
            message: `Stock disponible insuficiente para completar la operación`,
            details: [{ productId: opts.productId, requested: opts.quantity, available }],
          });
        }
      }

      const newFisico = isDecrease ? onHand - opts.quantity : onHand + opts.quantity;

      await tx.warehouseStock.update({
        where: { id: stock.id },
        data: { onHand: newFisico },
      });

      const movement = await tx.stockMovement.create({
        data: {
          tenantId: requireTenantId(),
          productId: opts.productId,
          warehouseId: opts.warehouseId,
          type: opts.type,
          quantity: opts.quantity,
          onHandBefore: onHand,
          onHandAfter: newFisico,
          reservedBefore: reserved,
          reservedAfter: reserved,
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
          onHand: newFisico,
          reserved,
          available: newFisico - reserved,
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
        INSERT INTO warehouse_stock (id, "tenantId", "productId", "warehouseId")
        VALUES (gen_random_uuid()::text, ${requireTenantId()}, ${opts.productId}, ${opts.toWarehouseId})
        ON CONFLICT ("productId", "warehouseId") DO NOTHING`;

      // Lock in a deterministic order so opposite-direction transfers cannot deadlock.
      const locked = new Map<string, WarehouseStock>();
      for (const warehouseId of [opts.fromWarehouseId, opts.toWarehouseId].sort()) {
        locked.set(warehouseId, (await lockWarehouseStock(tx, opts.productId, warehouseId))!);
      }
      const fromStock = locked.get(opts.fromWarehouseId)!;
      const toStock = locked.get(opts.toWarehouseId)!;

      const available = fromStock.onHand - fromStock.reserved;
      if (available < opts.quantity) {
        throw new ConflictException({
          error: 'INSUFFICIENT_STOCK',
          message: `Disponible en almacén origen: ${available}. Solicitado: ${opts.quantity}.`,
          details: [{ productId: opts.productId, requested: opts.quantity, available }],
        });
      }

      const newFromFisico = fromStock.onHand - opts.quantity;
      const newToFisico = toStock.onHand + opts.quantity;

      await tx.warehouseStock.update({ where: { id: fromStock.id }, data: { onHand: newFromFisico } });
      await tx.warehouseStock.update({ where: { id: toStock.id }, data: { onHand: newToFisico } });

      const outMov = await tx.stockMovement.create({
        data: {
          tenantId: requireTenantId(),
          productId: opts.productId,
          warehouseId: opts.fromWarehouseId,
          type: 'transfer_out',
          quantity: opts.quantity,
          onHandBefore: fromStock.onHand,
          onHandAfter: newFromFisico,
          reservedBefore: fromStock.reserved,
          reservedAfter: fromStock.reserved,
          referenceType: 'transfer',
          notes: opts.notes,
          operatorId: opts.operatorId,
          operatorName: opts.operatorName,
        },
      });
      const inMov = await tx.stockMovement.create({
        data: {
          tenantId: requireTenantId(),
          productId: opts.productId,
          warehouseId: opts.toWarehouseId,
          type: 'transfer_in',
          quantity: opts.quantity,
          onHandBefore: toStock.onHand,
          onHandAfter: newToFisico,
          reservedBefore: toStock.reserved,
          reservedAfter: toStock.reserved,
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
