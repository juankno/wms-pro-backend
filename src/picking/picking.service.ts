import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { OrderStatus, PickingItem, PickingOrder, Prisma, Priority } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { UploadsService } from '../uploads/uploads.service';
import { paginate, buildMeta } from '../common/dto/pagination.dto';
import { AuthUser } from '../common/types/request-with-user.interface';
import { assertWarehouseAccess } from '../common/utils/warehouse-scope';
import { lockWarehouseStock, lockWarehouseStocks, sumByProduct } from '../stock/stock-lock';
import { allocateOutbound, Allocation, putAway, suggestedLocations } from '../stock/location-stock';
import { OrderTargetStatus } from './dto/create-picking.dto';
import { requireTenantId } from '../tenancy/tenant-context';
import { PlanLimitsService } from '../tenancy/plan-limits.service';
import { recordPickedLots, returnPickedLots, takeFromLots } from '../stock/lot-stock';
import { nextReference } from '../sequences/sequence';
import { applySalesOrderProgress } from '../sales/sales-order-progress';

type LockedPickingOrder = PickingOrder & { items: PickingItem[] };

export interface NewPickingOrder {
  reference?: string;
  client?: string;
  customerId?: string;
  salesOrderId?: string;
  warehouseId: string;
  priority?: Priority;
  assignedToId?: string;
  notes?: string;
  items: { productId: string; quantity: number }[];
}

const ALLOWED_TRANSITIONS: Partial<Record<OrderStatus, OrderStatus[]>> = {
  pending: [OrderStatus.in_progress, OrderStatus.cancelled],
  in_progress: [OrderStatus.completed, OrderStatus.cancelled],
};

const EDITABLE_STATUSES: OrderStatus[] = [OrderStatus.pending, OrderStatus.in_progress];

@Injectable()
export class PickingService {
  constructor(
    private prisma: PrismaService,
    private activity: ActivityService,
    private uploads: UploadsService,
    private planLimits: PlanLimitsService,
  ) {}

  async findAll(opts: {
    warehouseId?: string;
    status?: OrderStatus;
    priority?: Priority;
    assignedTo?: string;
    search?: string;
    dateFrom?: string;
    dateTo?: string;
    page: number;
    limit: number;
  }) {
    const where: Prisma.PickingOrderWhereInput = {};
    if (opts.warehouseId) where.warehouseId = opts.warehouseId;
    if (opts.status) where.status = opts.status;
    if (opts.priority) where.priority = opts.priority;
    if (opts.assignedTo) where.assignedToId = opts.assignedTo;
    if (opts.search) {
      where.OR = [
        { reference: { contains: opts.search, mode: 'insensitive' } },
        { client: { contains: opts.search, mode: 'insensitive' } },
      ];
    }
    if (opts.dateFrom || opts.dateTo) {
      where.createdAt = {
        ...(opts.dateFrom && { gte: new Date(opts.dateFrom) }),
        ...(opts.dateTo && { lte: new Date(opts.dateTo) }),
      };
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

  async findById(id: string, user: AuthUser) {
    const order = await this.prisma.pickingOrder.findUnique({
      where: { id },
      include: {
        items: true,
        assignedTo: { select: { id: true, name: true } },
        customer: { select: { id: true, code: true, name: true } },
      },
    });
    if (!order) throw new NotFoundException({ error: 'ORDER_NOT_FOUND', message: 'Orden de picking no encontrada' });
    assertWarehouseAccess(user, order.warehouseId);
    return order;
  }

  async create(data: NewPickingOrder, user: AuthUser) {
    await this.planLimits.assertCanCreate('ordersPerMonth');
    return this.prisma.$transaction((tx) => this.createInTransaction(tx, data, user));
  }

  // Reserves the stock and creates the order inside the caller's transaction (sales order releases).
  async createInTransaction(tx: Prisma.TransactionClient, data: NewPickingOrder, user: AuthUser) {
    const client = await this.resolveClient(tx, data.client, data.customerId);
    const reference =
      data.reference ??
      (await nextReference(tx, 'picking', async (candidate) => !!(await tx.pickingOrder.findFirst({ where: { reference: candidate } }))));
    const requested = sumByProduct(data.items, (i) => i.quantity);
    const stocks = await lockWarehouseStocks(tx, data.warehouseId, [...requested.keys()]);

    const shortages = [...requested].flatMap(([productId, quantity]) => {
      const stock = stocks.get(productId);
      const available = stock ? stock.onHand - stock.reserved : 0;
      return available < quantity ? [{ productId, requested: quantity, available }] : [];
    });
    if (shortages.length > 0) {
      throw new ConflictException({
        error: 'INSUFFICIENT_STOCK',
        message: 'Stock insuficiente para uno o más ítems',
        details: shortages,
      });
    }

    for (const [productId, quantity] of requested) {
      await tx.warehouseStock.update({
        where: { id: stocks.get(productId)!.id },
        data: { reserved: { increment: quantity } },
      });
    }

    const suggestions = await suggestedLocations(tx, data.warehouseId, [...requested.keys()]);
    const products = await tx.product.findMany({ where: { id: { in: [...requested.keys()] } } });
    const productById = new Map(products.map((p) => [p.id, p]));

    const order = await tx.pickingOrder.create({
      data: {
        tenantId: requireTenantId(),
        reference,
        client: client.name,
        customerId: client.customerId,
        salesOrderId: data.salesOrderId,
        warehouseId: data.warehouseId,
        priority: data.priority ?? Priority.medium,
        assignedToId: data.assignedToId,
        notes: data.notes,
        createdById: user.id,
        items: {
          create: data.items.map((item) => {
            const product = productById.get(item.productId)!;
            return {
              productId: item.productId,
              productCode: product.code,
              productName: product.name,
              quantity: item.quantity,
              reservedQuantity: item.quantity,
              location: suggestions.get(item.productId) ?? stocks.get(item.productId)!.location,
              barcode: product.barcode ?? '',
              unit: product.unit,
            };
          }),
        },
      },
      include: { items: true },
    });

    await this.activity.log(
      {
        orderId: order.id,
        orderType: 'picking',
        action: 'created',
        detail: `Orden creada con ${order.items.length} ítems`,
        operator: user.name,
        userId: user.id,
        warehouseId: order.warehouseId,
      },
      tx,
    );

    return order;
  }

  async updateStatus(id: string, status: OrderTargetStatus, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const order = await this.lockOrder(tx, id, user);
      if (!ALLOWED_TRANSITIONS[order.status]?.includes(status)) {
        throw new UnprocessableEntityException({
          error: 'ORDER_INVALID_STATUS',
          message: `No se puede pasar de ${order.status} a ${status}`,
        });
      }

      if (status === OrderStatus.completed) {
        if (!order.items.some((i) => i.pickedQuantity > 0)) {
          throw new UnprocessableEntityException({
            error: 'PICKING_EMPTY',
            message: 'No se puede completar un picking sin ítems recogidos',
          });
        }
        await this.settleReservations(tx, order, (item) => item.pickedQuantity);
      }

      if (status === OrderStatus.cancelled) {
        await this.releasePicked(tx, order);
        await this.settleReservations(tx, order, () => 0);
        await this.returnToSalesOrder(tx, order);
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

      await this.activity.log(
        {
          orderId: id,
          orderType: 'picking',
          action: status === OrderStatus.in_progress ? 'started' : status,
          detail: `Orden ${status}`,
          operator: user.name,
          userId: user.id,
          warehouseId: order.warehouseId,
        },
        tx,
      );

      return updated;
    });
  }

  async updateItem(
    orderId: string,
    itemId: string,
    pickedQuantity: number,
    user: AuthUser,
    locationId?: string,
    lotId?: string,
  ) {
    return this.prisma.$transaction((tx) => this.updateItemInTransaction(tx, orderId, itemId, pickedQuantity, user, locationId, lotId));
  }

  // Sets the picked quantity inside the caller's transaction (wave picking spreads one pick over orders).
  async updateItemInTransaction(
    tx: Prisma.TransactionClient,
    orderId: string,
    itemId: string,
    pickedQuantity: number,
    user: AuthUser,
    locationId?: string,
    lotId?: string,
  ) {
    const order = await this.lockOrder(tx, orderId, user);
    this.assertEditable(order);

    const item = order.items.find((i) => i.id === itemId);
    if (!item) throw new NotFoundException({ error: 'ITEM_NOT_FOUND', message: 'Ítem no encontrado' });
    if (pickedQuantity > item.quantity) {
      throw new UnprocessableEntityException({
        error: 'QUANTITY_EXCEEDED',
        message: 'La cantidad recogida no puede superar la cantidad solicitada',
      });
    }

    const delta = pickedQuantity - item.pickedQuantity;
    if (delta !== 0) await this.movePickedUnits(tx, order, item, delta, user, locationId, lotId);

    const updatedItem = await tx.pickingItem.update({ where: { id: itemId }, data: { pickedQuantity } });
    await tx.pickingOrder.update({ where: { id: orderId }, data: { updatedAt: new Date() } });
    return updatedItem;
  }

  async update(
    id: string,
    data: Partial<{ client: string; notes: string; priority: Priority; assignedToId: string }>,
    user: AuthUser,
  ) {
    const order = await this.findById(id, user);
    this.assertEditable(order);
    return this.prisma.pickingOrder.update({ where: { id }, data });
  }

  async addPhoto(id: string, url: string, user: AuthUser) {
    const order = await this.findById(id, user);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.pickingOrder.update({ where: { id }, data: { photos: { push: url } } });
      await this.activity.log(
        {
          orderId: id, orderType: 'picking', action: 'photo_added',
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
      const result = await tx.pickingOrder.update({
        where: { id },
        data: { photos: order.photos.filter((p) => p !== photoUrl) },
      });
      await this.activity.log(
        {
          orderId: id, orderType: 'picking', action: 'photo_removed',
          detail: 'Foto eliminada', operator: user.name, userId: user.id, warehouseId: order.warehouseId,
        },
        tx,
      );
      return result;
    });
    await this.uploads.deleteFile(photoUrl);
    return updated;
  }

  async delete(id: string, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const order = await this.lockOrder(tx, id, user);
      if (order.status !== OrderStatus.pending) {
        throw new UnprocessableEntityException({
          error: 'ORDER_INVALID_STATUS',
          message: 'Solo se pueden eliminar órdenes en estado pending',
        });
      }
      await this.releasePicked(tx, order);
      await this.settleReservations(tx, order, () => 0);
      await this.returnToSalesOrder(tx, order);
      return tx.pickingOrder.delete({ where: { id } });
    });
  }

  private async lockOrder(tx: Prisma.TransactionClient, id: string, user: AuthUser): Promise<LockedPickingOrder> {
    await tx.$queryRaw`SELECT id FROM picking_orders WHERE id = ${id} AND "tenantId" = ${requireTenantId()} FOR UPDATE`;
    const order = await tx.pickingOrder.findUnique({ where: { id }, include: { items: true } });
    if (!order) throw new NotFoundException({ error: 'ORDER_NOT_FOUND', message: 'Orden de picking no encontrada' });
    assertWarehouseAccess(user, order.warehouseId);
    return order;
  }

  // Picked units leave their location (or return to it) and are counted in WarehouseStock.picked until shipped.
  private async movePickedUnits(
    tx: Prisma.TransactionClient,
    order: LockedPickingOrder,
    item: PickingItem,
    delta: number,
    user: AuthUser,
    locationId?: string,
    lotId?: string,
  ) {
    const stock = await lockWarehouseStock(tx, item.productId, order.warehouseId);
    if (!stock) throw new NotFoundException({ error: 'STOCK_NOT_FOUND', message: 'Registro de stock no encontrado' });

    let allocations: Allocation[];
    if (delta > 0) {
      allocations = await allocateOutbound(tx, stock, delta, locationId);
      await recordPickedLots(tx, item.id, await takeFromLots(tx, stock, delta, lotId));
    } else {
      if (locationId) await putAway(tx, stock, locationId, -delta);
      await returnPickedLots(tx, stock, [item.id], -delta, lotId);
      allocations = [{ locationId: locationId ?? null, quantity: -delta }];
    }
    await tx.warehouseStock.update({ where: { id: stock.id }, data: { picked: stock.picked + delta } });

    for (const allocation of allocations.filter((a) => a.locationId)) {
      await tx.stockMovement.create({
        data: {
          tenantId: requireTenantId(),
          productId: item.productId,
          warehouseId: order.warehouseId,
          type: 'relocation',
          quantity: allocation.quantity,
          onHandBefore: stock.onHand,
          onHandAfter: stock.onHand,
          reservedBefore: stock.reserved,
          reservedAfter: stock.reserved,
          referenceType: 'picking',
          referenceId: order.id,
          notes: `${delta > 0 ? 'Recogido' : 'Devuelto'} en picking ${order.reference}`,
          operatorId: user.id,
          operatorName: user.name,
          ...(delta > 0 ? { locationId: allocation.locationId } : { toLocationId: allocation.locationId }),
        },
      });
    }
  }

  // Units picked for an order that will not ship stay in the warehouse without a location, back in their lots.
  private async releasePicked(tx: Prisma.TransactionClient, order: LockedPickingOrder) {
    const picked = sumByProduct(order.items, (item) => item.pickedQuantity);
    const stocks = await lockWarehouseStocks(tx, order.warehouseId, [...picked.keys()]);
    for (const [productId, quantity] of picked) {
      const stock = stocks.get(productId);
      if (!stock || quantity === 0) continue;
      const itemIds = order.items.filter((item) => item.productId === productId).map((item) => item.id);
      await returnPickedLots(tx, stock, itemIds, quantity);
      await tx.warehouseStock.update({
        where: { id: stock.id },
        data: { picked: Math.max(0, stock.picked - quantity) },
      });
    }
  }

  // Quantities of a picking that will not ship become pending again in its sales order.
  private async returnToSalesOrder(tx: Prisma.TransactionClient, order: LockedPickingOrder) {
    if (!order.salesOrderId) return;
    const quantities = sumByProduct(order.items, (item) => item.quantity);
    await applySalesOrderProgress(
      tx,
      order.salesOrderId,
      new Map([...quantities].map(([productId, quantity]) => [productId, { released: -quantity, shipped: 0 }])),
    );
  }

  private async resolveClient(tx: Prisma.TransactionClient, client?: string, customerId?: string) {
    if (customerId) {
      const customer = await tx.partner.findUnique({ where: { id: customerId } });
      if (!customer?.active || !customer.isCustomer) {
        throw new NotFoundException({ error: 'CUSTOMER_NOT_FOUND', message: 'Cliente no encontrado o inactivo' });
      }
      return { name: client ?? customer.name, customerId };
    }
    if (!client) {
      throw new UnprocessableEntityException({ error: 'CLIENT_REQUIRED', message: 'Indica el cliente de la orden' });
    }
    return { name: client, customerId: undefined };
  }

  private assertEditable(order: PickingOrder) {
    if (!EDITABLE_STATUSES.includes(order.status)) {
      throw new UnprocessableEntityException({
        error: 'ORDER_INVALID_STATUS',
        message: `La orden está ${order.status} y no admite cambios`,
      });
    }
  }

  // Moves each item's reservation to `target(item)`, reserving or releasing the difference.
  private async settleReservations(
    tx: Prisma.TransactionClient,
    order: LockedPickingOrder,
    target: (item: PickingItem) => number,
  ) {
    const stocks = await lockWarehouseStocks(tx, order.warehouseId, order.items.map((i) => i.productId));

    for (const item of order.items) {
      const delta = target(item) - item.reservedQuantity;
      if (delta === 0) continue;

      const stock = stocks.get(item.productId);
      if (!stock) throw new NotFoundException({ error: 'STOCK_NOT_FOUND', message: 'Registro de stock no encontrado' });
      const available = stock.onHand - stock.reserved;
      if (delta > available) {
        throw new ConflictException({
          error: 'INSUFFICIENT_STOCK',
          message: 'No hay stock disponible para reservar',
          details: [{ productId: item.productId, requested: delta, available }],
        });
      }

      stock.reserved += delta;
      await tx.warehouseStock.update({ where: { id: stock.id }, data: { reserved: stock.reserved } });
      await tx.pickingItem.update({ where: { id: item.id }, data: { reservedQuantity: target(item) } });
    }
  }
}
