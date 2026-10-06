import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, SalesOrderStatus } from '@prisma/client';
import { buildMeta, paginate } from '../common/dto/pagination.dto';
import { AuthUser } from '../common/types/request-with-user.interface';
import { assertWarehouseAccess } from '../common/utils/warehouse-scope';
import { PickingService } from '../picking/picking.service';
import { PrismaService } from '../prisma/prisma.service';
import { nextReference } from '../sequences/sequence';
import { lockWarehouseStocks } from '../stock/stock-lock';
import { PlanLimitsService } from '../tenancy/plan-limits.service';
import { requireTenantId } from '../tenancy/tenant-context';
import { CreateSalesOrderDto } from './dto/sales-order.dto';
import { salesOrderStatus } from './sales-order-progress';

type Tx = Prisma.TransactionClient;

const SALES_ORDER_INCLUDE = {
  customer: { select: { id: true, code: true, name: true } },
  warehouse: { select: { id: true, code: true, name: true } },
  items: { include: { product: { select: { id: true, code: true, name: true, unit: true } } } },
  pickingOrders: { select: { id: true, reference: true, status: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.SalesOrderInclude;

const CLOSED_STATUSES: SalesOrderStatus[] = [SalesOrderStatus.shipped, SalesOrderStatus.cancelled];
const NOT_FOUND = { error: 'SALES_ORDER_NOT_FOUND', message: 'Pedido de venta no encontrado' };

@Injectable()
export class SalesOrdersService {
  constructor(
    private prisma: PrismaService,
    private picking: PickingService,
    private planLimits: PlanLimitsService,
  ) {}

  async findAll(opts: {
    status?: SalesOrderStatus[];
    customerId?: string;
    warehouseId?: string;
    search?: string;
    page: number;
    limit: number;
  }) {
    const where: Prisma.SalesOrderWhereInput = {
      status: opts.status && { in: opts.status },
      customerId: opts.customerId,
      warehouseId: opts.warehouseId,
      ...(opts.search && {
        OR: [
          { reference: { contains: opts.search, mode: 'insensitive' } },
          { client: { contains: opts.search, mode: 'insensitive' } },
        ],
      }),
    };
    const [data, total] = await Promise.all([
      this.prisma.salesOrder.findMany({ where, include: SALES_ORDER_INCLUDE, orderBy: { createdAt: 'desc' }, ...paginate(opts.page, opts.limit) }),
      this.prisma.salesOrder.count({ where }),
    ]);
    return { data, meta: buildMeta(total, opts.page, opts.limit) };
  }

  async findById(id: string, user: AuthUser) {
    const order = await this.prisma.salesOrder.findUnique({ where: { id }, include: SALES_ORDER_INCLUDE });
    if (!order) throw new NotFoundException(NOT_FOUND);
    assertWarehouseAccess(user, order.warehouseId);
    return order;
  }

  async create(dto: CreateSalesOrderDto, user: AuthUser) {
    assertWarehouseAccess(user, dto.warehouseId);
    return this.prisma.$transaction(async (tx) => {
      const client = await this.resolveClient(tx, dto.client, dto.customerId);
      await this.assertItems(tx, dto.items);
      const reference =
        dto.reference ??
        (await nextReference(tx, 'sales', async (candidate) => !!(await tx.salesOrder.findFirst({ where: { reference: candidate } }))));
      return tx.salesOrder.create({
        data: {
          tenantId: requireTenantId(),
          reference,
          customerId: client.customerId,
          client: client.name,
          warehouseId: dto.warehouseId,
          priority: dto.priority,
          requestedAt: dto.requestedAt ? new Date(dto.requestedAt) : undefined,
          notes: dto.notes,
          createdById: user.id,
          items: { create: dto.items },
        },
        include: SALES_ORDER_INCLUDE,
      });
    });
  }

  // Reserves what is pending through a new picking order; with allowPartial only what is available.
  async release(id: string, opts: { allowPartial?: boolean; assignedToId?: string }, user: AuthUser) {
    await this.planLimits.assertCanCreate('ordersPerMonth');
    const pickingOrder = await this.prisma.$transaction(async (tx) => {
      const order = await this.lockOrder(tx, id, user);
      if (CLOSED_STATUSES.includes(order.status)) throw this.invalidStatus(order.status);

      const pending = order.items
        .map((item) => ({ productId: item.productId, pending: item.quantity - item.releasedQuantity }))
        .filter((item) => item.pending > 0);
      if (pending.length === 0) {
        throw new UnprocessableEntityException({ error: 'NOTHING_TO_RELEASE', message: 'El pedido ya está liberado por completo' });
      }

      const stocks = await lockWarehouseStocks(tx, order.warehouseId, pending.map((item) => item.productId));
      const allocations = pending.map((item) => {
        const stock = stocks.get(item.productId);
        const available = stock ? Math.max(0, stock.onHand - stock.reserved) : 0;
        return { ...item, available, quantity: Math.min(item.pending, available) };
      });
      const short = allocations.filter((item) => item.quantity < item.pending);
      if ((short.length > 0 && !opts.allowPartial) || allocations.every((item) => item.quantity === 0)) {
        throw new ConflictException({
          error: 'INSUFFICIENT_STOCK',
          message: 'No hay stock disponible para liberar el pedido completo',
          details: short.map(({ productId, pending: requested, available }) => ({ productId, requested, available })),
        });
      }

      const releasable = allocations.filter((item) => item.quantity > 0);
      const created = await this.picking.createInTransaction(
        tx,
        {
          client: order.client,
          customerId: order.customerId ?? undefined,
          salesOrderId: order.id,
          warehouseId: order.warehouseId,
          priority: order.priority,
          assignedToId: opts.assignedToId,
          notes: `Pedido ${order.reference}`,
          items: releasable.map(({ productId, quantity }) => ({ productId, quantity })),
        },
        user,
      );
      for (const item of releasable) {
        await tx.salesOrderItem.updateMany({
          where: { salesOrderId: order.id, productId: item.productId },
          data: { releasedQuantity: { increment: item.quantity } },
        });
      }
      const items = await tx.salesOrderItem.findMany({ where: { salesOrderId: order.id } });
      await tx.salesOrder.update({ where: { id: order.id }, data: { status: salesOrderStatus(items) } });
      return created;
    });
    return { salesOrder: await this.findById(id, user), pickingOrder };
  }

  // Cancels what has not shipped; orders with picking still in progress must finish or cancel it first.
  async cancel(id: string, user: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const order = await this.lockOrder(tx, id, user);
      if (CLOSED_STATUSES.includes(order.status)) throw this.invalidStatus(order.status);
      if (order.items.some((item) => item.releasedQuantity > item.shippedQuantity)) {
        throw new UnprocessableEntityException({
          error: 'SALES_ORDER_IN_PROGRESS',
          message: 'El pedido tiene picking en curso; termínalo o cancélalo primero',
        });
      }
      await tx.salesOrder.update({ where: { id }, data: { status: SalesOrderStatus.cancelled } });
    });
    return this.findById(id, user);
  }

  private async lockOrder(tx: Tx, id: string, user: AuthUser) {
    await tx.$queryRaw`SELECT id FROM sales_orders WHERE id = ${id} AND "tenantId" = ${requireTenantId()} FOR UPDATE`;
    const order = await tx.salesOrder.findUnique({ where: { id }, include: { items: true } });
    if (!order) throw new NotFoundException(NOT_FOUND);
    assertWarehouseAccess(user, order.warehouseId);
    return order;
  }

  private async resolveClient(tx: Tx, client?: string, customerId?: string) {
    if (customerId) {
      const customer = await tx.partner.findUnique({ where: { id: customerId } });
      if (!customer?.active || !customer.isCustomer) {
        throw new NotFoundException({ error: 'CUSTOMER_NOT_FOUND', message: 'Cliente no encontrado o inactivo' });
      }
      return { name: client ?? customer.name, customerId };
    }
    if (!client) throw new UnprocessableEntityException({ error: 'CLIENT_REQUIRED', message: 'Indica el cliente del pedido' });
    return { name: client, customerId: undefined };
  }

  private async assertItems(tx: Tx, items: { productId: string }[]) {
    const productIds = items.map((item) => item.productId);
    if (new Set(productIds).size !== productIds.length) {
      throw new UnprocessableEntityException({ error: 'DUPLICATE_PRODUCT', message: 'Cada producto debe aparecer una sola vez en el pedido' });
    }
    const found = await tx.product.count({ where: { id: { in: productIds }, active: true } });
    if (found !== productIds.length) {
      throw new NotFoundException({ error: 'PRODUCT_NOT_FOUND', message: 'Productos no encontrados o inactivos' });
    }
  }

  private invalidStatus(status: SalesOrderStatus) {
    return new UnprocessableEntityException({
      error: 'SALES_ORDER_INVALID_STATUS',
      message: `El pedido está ${status} y no admite este cambio`,
    });
  }
}
