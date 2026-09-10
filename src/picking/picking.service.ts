import {
  Injectable,
  NotFoundException,
  ConflictException,
  UnprocessableEntityException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrderStatus, Role } from '@prisma/client';
import { paginate, buildMeta } from '../common/dto/pagination.dto';
import { AuthUser } from '../common/types/request-with-user.interface';

@Injectable()
export class PickingService {
  constructor(
    private prisma: PrismaService,
    private activity: ActivityService,
    private notifications: NotificationsService,
  ) {}

  async findAll(opts: {
    warehouseId: string;
    role: Role;
    status?: OrderStatus;
    assignedTo?: string;
    search?: string;
    from?: string;
    to?: string;
    page: number;
    limit: number;
  }) {
    const where: any = {};
    if (opts.role === Role.operator) where.warehouseId = opts.warehouseId;
    else if (opts.role === Role.supervisor) where.warehouseId = opts.warehouseId;
    if (opts.status) where.status = opts.status;
    if (opts.assignedTo) where.assignedToId = opts.assignedTo;
    if (opts.search) {
      where.OR = [
        { reference: { contains: opts.search, mode: 'insensitive' } },
        { client: { contains: opts.search, mode: 'insensitive' } },
      ];
    }
    if (opts.from || opts.to) {
      where.createdAt = {};
      if (opts.from) where.createdAt.gte = new Date(opts.from);
      if (opts.to) where.createdAt.lte = new Date(opts.to);
    }

    const [data, total] = await Promise.all([
      this.prisma.pickingOrder.findMany({
        where,
        include: { items: true, assignedTo: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        ...paginate(opts.page, opts.limit),
      }),
      this.prisma.pickingOrder.count({ where }),
    ]);

    return { data, meta: buildMeta(total, opts.page, opts.limit) };
  }

  async findById(id: string) {
    const order = await this.prisma.pickingOrder.findUnique({
      where: { id },
      include: { items: true, assignedTo: { select: { id: true, name: true } } },
    });
    if (!order) throw new NotFoundException({ error: 'ORDER_NOT_FOUND', message: 'Orden de picking no encontrada' });
    return order;
  }

  async create(data: {
    reference: string;
    client: string;
    warehouseId: string;
    priority?: any;
    assignedToId?: string;
    notes?: string;
    items: { productId: string; quantity: number }[];
    createdById: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const stockErrors: any[] = [];

      for (const item of data.items) {
        const stock = await tx.warehouseStock.findUnique({
          where: { productId_warehouseId: { productId: item.productId, warehouseId: data.warehouseId } },
          include: { product: true },
        });
        const disponible = stock ? stock.stockFisico - stock.stockReservado : 0;
        if (disponible < item.quantity) {
          stockErrors.push({
            productId: item.productId,
            productCode: stock?.product?.code ?? '',
            solicitado: item.quantity,
            disponible,
          });
        }
      }

      if (stockErrors.length > 0) {
        throw new ConflictException({
          error: 'STOCK_INSUFICIENTE',
          message: 'Stock insuficiente para uno o más ítems',
          items: stockErrors,
        });
      }

      const itemsWithDetails = await Promise.all(
        data.items.map(async (item) => {
          const stock = await tx.warehouseStock.findUnique({
            where: { productId_warehouseId: { productId: item.productId, warehouseId: data.warehouseId } },
            include: { product: true },
          });
          return {
            productId: item.productId,
            productCode: stock?.product?.code ?? '',
            productName: stock?.product?.name ?? '',
            quantity: item.quantity,
            location: stock?.location ?? '',
            barcode: stock?.product?.barcode ?? '',
            unit: stock?.product?.unit ?? 'UND',
          };
        }),
      );

      const order = await tx.pickingOrder.create({
        data: {
          reference: data.reference,
          client: data.client,
          warehouseId: data.warehouseId,
          priority: data.priority ?? 'medium',
          assignedToId: data.assignedToId,
          notes: data.notes,
          createdById: data.createdById,
          items: { create: itemsWithDetails },
        },
        include: { items: true },
      });

      return order;
    });
  }

  async updateStatus(id: string, status: OrderStatus, userId: string, userName: string) {
    const order = await this.findById(id);
    const valid = this.isValidTransition(order.status, status);
    if (!valid) {
      throw new UnprocessableEntityException({
        error: 'ORDER_INVALID_STATUS',
        message: `No se puede pasar de ${order.status} a ${status}`,
      });
    }

    return this.prisma.$transaction(async (tx) => {
      if (status === OrderStatus.cancelled && order.status === OrderStatus.in_progress) {
        for (const item of order.items) {
          if (item.reservedQuantity > 0) {
            await tx.warehouseStock.update({
              where: { productId_warehouseId: { productId: item.productId, warehouseId: order.warehouseId } },
              data: { stockReservado: { decrement: item.reservedQuantity } },
            });
            const stock = await tx.warehouseStock.findUnique({
              where: { productId_warehouseId: { productId: item.productId, warehouseId: order.warehouseId } },
            });
            await tx.stockMovement.create({
              data: {
                productId: item.productId,
                warehouseId: order.warehouseId,
                type: 'entrada_devolucion',
                quantity: item.reservedQuantity,
                stockFisicoAntes: stock?.stockFisico ?? 0,
                stockFisicoDespues: stock?.stockFisico ?? 0,
                stockReservadoAntes: (stock?.stockReservado ?? 0) + item.reservedQuantity,
                stockReservadoDespues: stock?.stockReservado ?? 0,
                referenceType: 'picking',
                referenceId: id,
                notes: 'Liberación por cancelación de picking',
                operatorId: userId,
                operatorName: userName,
              },
            });
          }
        }
        await tx.pickingItem.updateMany({ where: { pickingOrderId: id }, data: { reservedQuantity: 0 } });
      }

      const updated = await tx.pickingOrder.update({
        where: { id },
        data: {
          status,
          completedAt: status === OrderStatus.completed ? new Date() : undefined,
          cancelledAt: status === OrderStatus.cancelled ? new Date() : undefined,
        },
        include: { items: true },
      });

      await this.activity.log({
        orderId: id,
        orderType: 'picking',
        action: status === OrderStatus.cancelled ? 'cancelled' : status === OrderStatus.completed ? 'completed' : 'started',
        detail: `Orden ${status}`,
        operator: userName,
        userId,
        warehouseId: order.warehouseId,
      });

      return updated;
    });
  }

  async updateItem(orderId: string, itemId: string, pickedQuantity: number, userId: string, userName: string) {
    const order = await this.findById(orderId);
    const item = order.items.find((i) => i.id === itemId);
    if (!item) throw new NotFoundException({ error: 'ORDER_NOT_FOUND', message: 'Ítem no encontrado' });

    return this.prisma.$transaction(async (tx) => {
      const delta = pickedQuantity - item.reservedQuantity;

      if (delta > 0) {
        const stock = await tx.warehouseStock.findUnique({
          where: { productId_warehouseId: { productId: item.productId, warehouseId: order.warehouseId } },
        });
        const disponible = (stock?.stockFisico ?? 0) - (stock?.stockReservado ?? 0);
        if (disponible < delta) {
          throw new ConflictException({
            error: 'STOCK_INSUFICIENTE',
            message: 'No hay stock disponible para reservar.',
          });
        }
        await tx.warehouseStock.update({
          where: { productId_warehouseId: { productId: item.productId, warehouseId: order.warehouseId } },
          data: { stockReservado: { increment: delta } },
        });
      } else if (delta < 0) {
        await tx.warehouseStock.update({
          where: { productId_warehouseId: { productId: item.productId, warehouseId: order.warehouseId } },
          data: { stockReservado: { decrement: Math.abs(delta) } },
        });
      }

      const updatedItem = await tx.pickingItem.update({
        where: { id: itemId },
        data: { pickedQuantity, reservedQuantity: pickedQuantity },
      });

      await tx.pickingOrder.update({ where: { id: orderId }, data: { updatedAt: new Date() } });

      return updatedItem;
    });
  }

  async update(id: string, data: Partial<{ client: string; notes: string; priority: any; assignedToId: string }>) {
    await this.findById(id);
    return this.prisma.pickingOrder.update({ where: { id }, data: { ...data, updatedAt: new Date() } });
  }

  async addPhoto(id: string, url: string, operator: AuthUser) {
    const order = await this.findById(id);
    const updated = await this.prisma.pickingOrder.update({
      where: { id },
      data: { photos: { push: url } },
    });
    await this.activity.log({
      orderId: id, orderType: 'picking', action: 'photo_added',
      detail: 'Foto añadida', operator: operator.name, userId: operator.id, warehouseId: order.warehouseId,
    });
    return updated;
  }

  async removePhoto(id: string, photoUrl: string, operator: AuthUser) {
    const order = await this.findById(id);
    const updated = await this.prisma.pickingOrder.update({
      where: { id },
      data: { photos: order.photos.filter((p) => p !== photoUrl) },
    });
    await this.activity.log({
      orderId: id, orderType: 'picking', action: 'photo_removed',
      detail: 'Foto eliminada', operator: operator.name, userId: operator.id, warehouseId: order.warehouseId,
    });
    return updated;
  }

  async delete(id: string) {
    const order = await this.findById(id);
    if (order.status !== OrderStatus.pending) {
      throw new UnprocessableEntityException({ error: 'ORDER_INVALID_STATUS', message: 'Solo se pueden eliminar órdenes en estado pending' });
    }
    return this.prisma.pickingOrder.delete({ where: { id } });
  }

  private isValidTransition(from: OrderStatus, to: OrderStatus): boolean {
    const transitions: Record<string, OrderStatus[]> = {
      pending: [OrderStatus.in_progress, OrderStatus.cancelled],
      in_progress: [OrderStatus.completed, OrderStatus.cancelled],
    };
    return transitions[from]?.includes(to) ?? false;
  }
}
