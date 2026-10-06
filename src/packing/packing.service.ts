import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { OrderStatus, PackingItem, PackingOrder, PickingItem, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { UploadsService } from '../uploads/uploads.service';
import { paginate, buildMeta } from '../common/dto/pagination.dto';
import { AuthUser } from '../common/types/request-with-user.interface';
import { assertWarehouseAccess } from '../common/utils/warehouse-scope';
import { lockWarehouseStocks, sumByProduct } from '../stock/stock-lock';
import { OrderTargetStatus } from '../picking/dto/create-picking.dto';
import { requireTenantId } from '../tenancy/tenant-context';
import { returnPickedLots } from '../stock/lot-stock';

type LockedPackingOrder = PackingOrder & { items: PackingItem[]; pickingItems: PickingItem[] };

const ALLOWED_TRANSITIONS: Partial<Record<OrderStatus, OrderStatus[]>> = {
  pending: [OrderStatus.in_progress, OrderStatus.cancelled],
  in_progress: [OrderStatus.completed, OrderStatus.cancelled],
};

const EDITABLE_STATUSES: OrderStatus[] = [OrderStatus.pending, OrderStatus.in_progress];

@Injectable()
export class PackingService {
  constructor(
    private prisma: PrismaService,
    private activity: ActivityService,
    private uploads: UploadsService,
  ) {}

  async findAll(opts: {
    warehouseId?: string;
    status?: OrderStatus;
    assignedTo?: string;
    search?: string;
    dateFrom?: string;
    dateTo?: string;
    page: number;
    limit: number;
  }) {
    const where: Prisma.PackingOrderWhereInput = {};
    if (opts.warehouseId) where.warehouseId = opts.warehouseId;
    if (opts.status) where.status = opts.status;
    if (opts.assignedTo) where.assignedToId = opts.assignedTo;
    if (opts.search) {
      where.OR = [
        { reference: { contains: opts.search, mode: 'insensitive' } },
        { pickingOrder: { reference: { contains: opts.search, mode: 'insensitive' } } },
      ];
    }
    if (opts.dateFrom || opts.dateTo) {
      where.createdAt = {
        ...(opts.dateFrom && { gte: new Date(opts.dateFrom) }),
        ...(opts.dateTo && { lte: new Date(opts.dateTo) }),
      };
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

  async findById(id: string, user: AuthUser) {
    const order = await this.prisma.packingOrder.findUnique({
      where: { id },
      include: { items: true, boxes: true, pickingOrder: true, assignedTo: { select: { id: true, name: true } } },
    });
    if (!order) throw new NotFoundException({ error: 'ORDER_NOT_FOUND', message: 'Orden de packing no encontrada' });
    assertWarehouseAccess(user, order.warehouseId);
    return order;
  }

  async create(
    data: { pickingOrderId: string; reference?: string; assignedToId?: string; notes?: string },
    user: AuthUser,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM picking_orders WHERE id = ${data.pickingOrderId} AND "tenantId" = ${requireTenantId()} FOR UPDATE`;
      const picking = await tx.pickingOrder.findUnique({
        where: { id: data.pickingOrderId },
        include: { items: true, packingOrder: true },
      });

      if (!picking) throw new NotFoundException({ error: 'ORDER_NOT_FOUND', message: 'Orden de picking no encontrada' });
      assertWarehouseAccess(user, picking.warehouseId);
      if (picking.status !== OrderStatus.completed) {
        throw new UnprocessableEntityException({
          error: 'PICKING_INCOMPLETE',
          message: 'El picking debe estar completado para crear el packing',
        });
      }
      if (picking.packingOrder) {
        throw new ConflictException({ error: 'ORDER_INVALID_STATUS', message: 'Ya existe un packing para este picking' });
      }

      const order = await tx.packingOrder.create({
        data: {
          tenantId: requireTenantId(),
          pickingOrderId: data.pickingOrderId,
          reference: data.reference ?? picking.reference,
          client: picking.client,
          warehouseId: picking.warehouseId,
          assignedToId: data.assignedToId,
          notes: data.notes,
          createdById: user.id,
          items: {
            create: picking.items
              .filter((item) => item.pickedQuantity > 0)
              .map((item) => ({
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

      await this.activity.log(
        {
          orderId: order.id,
          orderType: 'packing',
          action: 'created',
          detail: `Packing creado desde ${picking.reference}`,
          operator: user.name,
          userId: user.id,
          warehouseId: order.warehouseId,
        },
        tx,
      );

      return order;
    });
  }

  async updateStatus(id: string, status: OrderTargetStatus, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const order = await this.lockOrder(tx, id, user);
      if (!ALLOWED_TRANSITIONS[order.status]?.includes(status)) {
        throw new UnprocessableEntityException({
          error: 'ORDER_INVALID_STATUS',
          message: `Transición de estado inválida: ${order.status} → ${status}`,
        });
      }

      if (status === OrderStatus.completed) {
        if (!order.items.some((i) => i.packedQuantity > 0)) {
          throw new UnprocessableEntityException({
            error: 'PACKING_EMPTY',
            message: 'No se puede completar un packing sin ítems empacados',
          });
        }
        await this.consumeReservations(tx, order, user);
      }

      if (status === OrderStatus.cancelled) {
        await this.consumeReservations(tx, { ...order, items: [] }, user);
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

      await this.activity.log(
        {
          orderId: id,
          orderType: 'packing',
          action: status === OrderStatus.completed ? 'stock_confirmed' : status,
          detail: `Packing ${status}`,
          operator: user.name,
          userId: user.id,
          warehouseId: order.warehouseId,
        },
        tx,
      );

      return updated;
    });
  }

  async updateItem(orderId: string, itemId: string, packedQuantity: number, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const order = await this.lockOrder(tx, orderId, user);
      this.assertEditable(order);

      const item = order.items.find((i) => i.id === itemId);
      if (!item) throw new NotFoundException({ error: 'ITEM_NOT_FOUND', message: 'Ítem no encontrado' });
      if (packedQuantity > item.quantity) {
        throw new UnprocessableEntityException({
          error: 'QUANTITY_EXCEEDED',
          message: 'La cantidad empacada no puede superar la cantidad total del ítem',
        });
      }
      return tx.packingItem.update({ where: { id: itemId }, data: { packedQuantity } });
    });
  }

  async update(id: string, data: Partial<{ notes: string; assignedToId: string; totalWeight: number }>, user: AuthUser) {
    const order = await this.findById(id, user);
    this.assertEditable(order);
    return this.prisma.packingOrder.update({ where: { id }, data });
  }

  async addBox(packingOrderId: string, box: { label: string; weight?: number }, user: AuthUser) {
    const order = await this.findById(packingOrderId, user);
    this.assertEditable(order);
    return this.prisma.packingBox.create({ data: { packingOrderId, label: box.label, weight: box.weight } });
  }

  async sealBox(packingOrderId: string, boxId: string, user: AuthUser) {
    const order = await this.findById(packingOrderId, user);
    this.assertEditable(order);
    const box = order.boxes.find((b) => b.id === boxId);
    if (!box) throw new NotFoundException({ error: 'BOX_NOT_FOUND', message: 'Caja no encontrada' });
    return this.prisma.packingBox.update({ where: { id: boxId }, data: { sealed: true } });
  }

  async addPhoto(id: string, url: string, user: AuthUser) {
    const order = await this.findById(id, user);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.packingOrder.update({ where: { id }, data: { photos: { push: url } } });
      await this.activity.log(
        {
          orderId: id, orderType: 'packing', action: 'photo_added',
          detail: 'Foto añadida', operator: user.name, userId: user.id, warehouseId: order.warehouseId,
        },
        tx,
      );
      return updated;
    });
  }

  async removePhoto(id: string, photoUrl: string, user: AuthUser) {
    const order = await this.findById(id, user);
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.packingOrder.update({
        where: { id },
        data: { photos: order.photos.filter((p) => p !== photoUrl) },
      });
      await this.activity.log(
        {
          orderId: id, orderType: 'packing', action: 'photo_removed',
          detail: 'Foto eliminada', operator: user.name, userId: user.id, warehouseId: order.warehouseId,
        },
        tx,
      );
      return result;
    });
    await this.uploads.deleteFile(photoUrl);
    return updated;
  }

  // Deleting a pending packing keeps the picking reservation so a new packing can be created.
  async delete(id: string, user: AuthUser) {
    const order = await this.findById(id, user);
    if (order.status !== OrderStatus.pending) {
      throw new UnprocessableEntityException({
        error: 'ORDER_INVALID_STATUS',
        message: 'Solo se pueden eliminar órdenes pending',
      });
    }
    return this.prisma.packingOrder.delete({ where: { id } });
  }

  private async lockOrder(tx: Prisma.TransactionClient, id: string, user: AuthUser): Promise<LockedPackingOrder> {
    await tx.$queryRaw`SELECT id FROM packing_orders WHERE id = ${id} AND "tenantId" = ${requireTenantId()} FOR UPDATE`;
    const order = await tx.packingOrder.findUnique({
      where: { id },
      include: { items: true, pickingOrder: { include: { items: true } } },
    });
    if (!order) throw new NotFoundException({ error: 'ORDER_NOT_FOUND', message: 'Orden de packing no encontrada' });
    assertWarehouseAccess(user, order.warehouseId);
    const { pickingOrder, ...rest } = order;
    return { ...rest, pickingItems: pickingOrder.items };
  }

  private assertEditable(order: PackingOrder) {
    if (!EDITABLE_STATUSES.includes(order.status)) {
      throw new UnprocessableEntityException({
        error: 'ORDER_INVALID_STATUS',
        message: `La orden está ${order.status} y no admite cambios`,
      });
    }
  }

  private async singleShippedLot(tx: Prisma.TransactionClient, pickingItemIds: string[]) {
    const lots = await tx.pickingItemLot.findMany({
      where: { pickingItemId: { in: pickingItemIds }, quantity: { gt: 0 } },
      distinct: ['lotId'],
      select: { lotId: true },
    });
    return lots.length === 1 ? lots[0].lotId : undefined;
  }

  // Ships the packed quantities and releases the whole picking reservation (packed or not).
  private async consumeReservations(tx: Prisma.TransactionClient, order: LockedPackingOrder, user: AuthUser) {
    const reserved = sumByProduct(order.pickingItems, (i) => i.reservedQuantity);
    const shipped = sumByProduct(order.items, (i) => i.packedQuantity);
    const picked = sumByProduct(order.pickingItems, (i) => i.pickedQuantity);
    const productIds = [...reserved.keys(), ...shipped.keys(), ...picked.keys()];
    const stocks = await lockWarehouseStocks(tx, order.warehouseId, productIds);

    for (const productId of new Set(productIds)) {
      const stock = stocks.get(productId);
      if (!stock) throw new NotFoundException({ error: 'STOCK_NOT_FOUND', message: 'Registro de stock no encontrado' });

      const release = reserved.get(productId) ?? 0;
      const quantity = shipped.get(productId) ?? 0;
      const fisicoDespues = stock.onHand - quantity;
      const reservadoDespues = stock.reserved - release;
      if (fisicoDespues < reservadoDespues) {
        throw new ConflictException({
          error: 'INSUFFICIENT_STOCK',
          message: 'El stock físico no alcanza para despachar sin afectar otras reservas',
          details: [{ productId, requested: quantity, available: stock.onHand - reservadoDespues }],
        });
      }

      const itemIds = order.pickingItems.filter((item) => item.productId === productId).map((item) => item.id);
      const unshipped = (picked.get(productId) ?? 0) - quantity;
      if (unshipped > 0) await returnPickedLots(tx, stock, itemIds, unshipped);
      const shippedLotId = await this.singleShippedLot(tx, itemIds);

      await tx.warehouseStock.update({
        where: { id: stock.id },
        // Every picked unit leaves `picked`: shipped ones are gone and the rest stay without a location.
        data: {
          onHand: fisicoDespues,
          reserved: reservadoDespues,
          picked: Math.max(0, stock.picked - (picked.get(productId) ?? 0)),
        },
      });

      if (quantity > 0) {
        await tx.stockMovement.create({
          data: {
            tenantId: requireTenantId(),
            productId,
            warehouseId: order.warehouseId,
            type: 'order_shipment',
            quantity,
            onHandBefore: stock.onHand,
            onHandAfter: fisicoDespues,
            reservedBefore: stock.reserved,
            reservedAfter: reservadoDespues,
            referenceType: 'packing',
            referenceId: order.id,
            operatorId: user.id,
            operatorName: user.name,
            lotId: shippedLotId,
          },
        });
      }
    }

    await tx.pickingItem.updateMany({
      where: { pickingOrderId: order.pickingOrderId },
      data: { reservedQuantity: 0 },
    });
  }
}
