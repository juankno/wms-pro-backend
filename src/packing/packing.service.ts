import {
  Injectable,
  NotFoundException,
  ConflictException,
  UnprocessableEntityException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { UploadsService } from '../uploads/uploads.service';
import { OrderStatus, Role } from '@prisma/client';
import { paginate, buildMeta } from '../common/dto/pagination.dto';
import { AuthUser } from '../common/types/request-with-user.interface';

@Injectable()
export class PackingService {
  constructor(
    private prisma: PrismaService,
    private activity: ActivityService,
    private uploads: UploadsService,
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
    if (opts.role !== Role.admin) where.warehouseId = opts.warehouseId;
    if (opts.status) where.status = opts.status;
    if (opts.assignedTo) where.assignedToId = opts.assignedTo;
    if (opts.search) {
      where.OR = [
        { reference: { contains: opts.search, mode: 'insensitive' } },
        { pickingOrder: { reference: { contains: opts.search, mode: 'insensitive' } } },
      ];
    }
    if (opts.from || opts.to) {
      where.createdAt = {};
      if (opts.from) where.createdAt.gte = new Date(opts.from);
      if (opts.to) where.createdAt.lte = new Date(opts.to);
    }

    const [data, total] = await Promise.all([
      this.prisma.packingOrder.findMany({
        where,
        include: { items: true, boxes: true, assignedTo: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        ...paginate(opts.page, opts.limit),
      }),
      this.prisma.packingOrder.count({ where }),
    ]);

    return { data, meta: buildMeta(total, opts.page, opts.limit) };
  }

  async findById(id: string) {
    const order = await this.prisma.packingOrder.findUnique({
      where: { id },
      include: { items: true, boxes: true, pickingOrder: true, assignedTo: { select: { id: true, name: true } } },
    });
    if (!order) throw new NotFoundException({ error: 'ORDER_NOT_FOUND', message: 'Orden de packing no encontrada' });
    return order;
  }

  async create(data: {
    pickingOrderId: string;
    reference: string;
    assignedToId?: string;
    notes?: string;
    createdById: string;
  }) {
    const picking = await this.prisma.pickingOrder.findUnique({
      where: { id: data.pickingOrderId },
      include: { items: true, packingOrder: true },
    });

    if (!picking) throw new NotFoundException({ error: 'ORDER_NOT_FOUND', message: 'Orden de picking no encontrada' });
    if (picking.status !== OrderStatus.completed) {
      throw new UnprocessableEntityException({ error: 'PICKING_INCOMPLETE', message: 'El picking debe estar completado para crear el packing' });
    }
    if (picking.packingOrder) {
      throw new ConflictException({ error: 'ORDER_INVALID_STATUS', message: 'Ya existe un packing para este picking' });
    }

    return this.prisma.packingOrder.create({
      data: {
        pickingOrderId: data.pickingOrderId,
        reference: data.reference,
        client: picking.client,
        warehouseId: picking.warehouseId,
        assignedToId: data.assignedToId,
        notes: data.notes,
        createdById: data.createdById,
        items: {
          create: picking.items.map((item) => ({
            productId: item.productId,
            productCode: item.productCode,
            productName: item.productName,
            quantity: item.pickedQuantity,
            barcode: item.barcode ?? '',
            unit: item.unit,
          })),
        },
      },
      include: { items: true },
    });
  }

  async updateStatus(id: string, status: OrderStatus, userId: string, userName: string) {
    const order = await this.findById(id);
    const valid = this.isValidTransition(order.status, status);
    if (!valid) {
      throw new UnprocessableEntityException({ error: 'ORDER_INVALID_STATUS', message: `Transición de estado inválida: ${order.status} → ${status}` });
    }

    return this.prisma.$transaction(async (tx) => {
      if (status === OrderStatus.completed) {
        for (const item of order.items) {
          const stock = await tx.warehouseStock.findUnique({
            where: { productId_warehouseId: { productId: item.productId, warehouseId: order.warehouseId } },
          });
          await tx.stockMovement.create({
            data: {
              productId: item.productId,
              warehouseId: order.warehouseId,
              type: 'salida_picking',
              quantity: item.packedQuantity,
              stockFisicoAntes: stock?.stockFisico ?? 0,
              stockFisicoDespues: (stock?.stockFisico ?? 0) - item.packedQuantity,
              stockReservadoAntes: stock?.stockReservado ?? 0,
              stockReservadoDespues: (stock?.stockReservado ?? 0) - item.packedQuantity,
              referenceType: 'packing',
              referenceId: id,
              operatorId: userId,
              operatorName: userName,
            },
          });
          await tx.warehouseStock.update({
            where: { productId_warehouseId: { productId: item.productId, warehouseId: order.warehouseId } },
            data: {
              stockFisico: { decrement: item.packedQuantity },
              stockReservado: { decrement: item.packedQuantity },
            },
          });
        }
      }

      const updated = await tx.packingOrder.update({
        where: { id },
        data: {
          status,
          completedAt: status === OrderStatus.completed ? new Date() : undefined,
          cancelledAt: status === OrderStatus.cancelled ? new Date() : undefined,
        },
        include: { items: true, boxes: true },
      });

      await this.activity.log({
        orderId: id,
        orderType: 'packing',
        action: status === OrderStatus.completed ? 'stock_confirmed' : status,
        detail: `Packing ${status}`,
        operator: userName,
        userId,
        warehouseId: order.warehouseId,
      });

      return updated;
    });
  }

  async addBox(packingOrderId: string, label: string) {
    return this.prisma.packingBox.create({ data: { packingOrderId, label } });
  }

  async sealBox(packingOrderId: string, boxId: string) {
    const box = await this.prisma.packingBox.findFirst({ where: { id: boxId, packingOrderId } });
    if (!box) throw new NotFoundException({ error: 'ORDER_NOT_FOUND', message: 'Caja no encontrada' });
    return this.prisma.packingBox.update({ where: { id: boxId }, data: { sealed: true } });
  }

  async updateItem(orderId: string, itemId: string, packedQuantity: number) {
    const order = await this.findById(orderId);
    const item = order.items.find((i) => i.id === itemId);
    if (!item) throw new NotFoundException({ error: 'ORDER_NOT_FOUND', message: 'Ítem no encontrado' });
    if (packedQuantity > item.quantity) {
      throw new BadRequestException({ error: 'VALIDATION_ERROR', message: 'La cantidad empacada no puede superar la cantidad total del ítem' });
    }
    return this.prisma.packingItem.update({ where: { id: itemId }, data: { packedQuantity } });
  }

  async update(id: string, data: Partial<{ notes: string; assignedToId: string; totalWeight: number }>) {
    await this.findById(id);
    return this.prisma.packingOrder.update({ where: { id }, data });
  }

  async addPhoto(id: string, url: string, operator: AuthUser) {
    const order = await this.findById(id);
    const updated = await this.prisma.packingOrder.update({
      where: { id },
      data: { photos: { push: url } },
    });
    await this.activity.log({
      orderId: id, orderType: 'packing', action: 'photo_added',
      detail: 'Foto añadida', operator: operator.name, userId: operator.id, warehouseId: order.warehouseId,
    });
    return updated;
  }

  async removePhoto(id: string, photoUrl: string, operator: AuthUser) {
    const order = await this.findById(id);
    const updated = await this.prisma.packingOrder.update({
      where: { id },
      data: { photos: order.photos.filter((p) => p !== photoUrl) },
    });
    this.uploads.deleteFile(photoUrl);
    await this.activity.log({
      orderId: id, orderType: 'packing', action: 'photo_removed',
      detail: 'Foto eliminada', operator: operator.name, userId: operator.id, warehouseId: order.warehouseId,
    });
    return updated;
  }

  async delete(id: string) {
    const order = await this.findById(id);
    if (order.status !== OrderStatus.pending) {
      throw new UnprocessableEntityException({ error: 'ORDER_INVALID_STATUS', message: 'Solo se pueden eliminar órdenes pending' });
    }
    return this.prisma.packingOrder.delete({ where: { id } });
  }

  private isValidTransition(from: OrderStatus, to: OrderStatus): boolean {
    const transitions: Record<string, OrderStatus[]> = {
      pending: [OrderStatus.in_progress, OrderStatus.cancelled],
      in_progress: [OrderStatus.completed, OrderStatus.cancelled],
    };
    return transitions[from]?.includes(to) ?? false;
  }
}
