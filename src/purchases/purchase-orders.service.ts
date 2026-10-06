import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, PurchaseOrderStatus } from '@prisma/client';
import { buildMeta, paginate } from '../common/dto/pagination.dto';
import { AuthUser } from '../common/types/request-with-user.interface';
import { assertWarehouseAccess } from '../common/utils/warehouse-scope';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenancy/tenant-context';
import { CreatePurchaseOrderDto, PurchaseOrderItemDto, UpdatePurchaseOrderDto } from './dto/purchase-order.dto';
import { nextReference } from '../sequences/sequence';

type Tx = Prisma.TransactionClient;

export const PURCHASE_ORDER_INCLUDE = {
  supplier: { select: { id: true, code: true, name: true } },
  warehouse: { select: { id: true, code: true, name: true } },
  items: { include: { product: { select: { id: true, code: true, name: true, unit: true, lotTracking: true } } } },
} satisfies Prisma.PurchaseOrderInclude;

const NOT_FOUND = { error: 'PURCHASE_ORDER_NOT_FOUND', message: 'Orden de compra no encontrada' };

@Injectable()
export class PurchaseOrdersService {
  constructor(private prisma: PrismaService) {}

  async findAll(opts: {
    status?: PurchaseOrderStatus[];
    supplierId?: string;
    warehouseId?: string;
    search?: string;
    page: number;
    limit: number;
  }) {
    const where: Prisma.PurchaseOrderWhereInput = {
      status: opts.status && { in: opts.status },
      supplierId: opts.supplierId,
      warehouseId: opts.warehouseId,
      ...(opts.search && {
        OR: [
          { reference: { contains: opts.search, mode: 'insensitive' } },
          { supplier: { name: { contains: opts.search, mode: 'insensitive' } } },
        ],
      }),
    };
    const [data, total] = await Promise.all([
      this.prisma.purchaseOrder.findMany({
        where,
        include: PURCHASE_ORDER_INCLUDE,
        orderBy: { createdAt: 'desc' },
        ...paginate(opts.page, opts.limit),
      }),
      this.prisma.purchaseOrder.count({ where }),
    ]);
    return { data, meta: buildMeta(total, opts.page, opts.limit) };
  }

  async findById(id: string, user: AuthUser) {
    const order = await this.prisma.purchaseOrder.findUnique({ where: { id }, include: PURCHASE_ORDER_INCLUDE });
    if (!order) throw new NotFoundException(NOT_FOUND);
    assertWarehouseAccess(user, order.warehouseId);
    return order;
  }

  async create(dto: CreatePurchaseOrderDto, user: AuthUser) {
    assertWarehouseAccess(user, dto.warehouseId);
    return this.prisma.$transaction(async (tx) => {
      await this.assertSupplier(tx, dto.supplierId);
      await this.assertWarehouse(tx, dto.warehouseId);
      await this.assertItems(tx, dto.items);
      const reference =
        dto.reference ??
        (await nextReference(tx, 'purchase', async (candidate) => !!(await tx.purchaseOrder.findFirst({ where: { reference: candidate } }))));
      return tx.purchaseOrder.create({
        data: {
          tenantId: requireTenantId(),
          reference,
          supplierId: dto.supplierId,
          warehouseId: dto.warehouseId,
          expectedAt: dto.expectedAt ? new Date(dto.expectedAt) : undefined,
          notes: dto.notes,
          createdById: user.id,
          items: { create: dto.items },
        },
        include: PURCHASE_ORDER_INCLUDE,
      });
    });
  }

  async update(id: string, dto: UpdatePurchaseOrderDto, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const order = await this.lockOrder(tx, id, user);
      if (order.status !== PurchaseOrderStatus.open) throw this.invalidStatus(order.status);
      if (dto.items) {
        if (order.items.some((item) => item.receivedQuantity > 0)) {
          throw new UnprocessableEntityException({
            error: 'PURCHASE_ORDER_RECEIVING',
            message: 'La orden ya tiene unidades recibidas; sus ítems no se pueden cambiar',
          });
        }
        await this.assertItems(tx, dto.items);
        await tx.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: id } });
        await tx.purchaseOrderItem.createMany({ data: dto.items.map((item) => ({ ...item, purchaseOrderId: id })) });
      }
      return tx.purchaseOrder.update({
        where: { id },
        data: { expectedAt: dto.expectedAt ? new Date(dto.expectedAt) : undefined, notes: dto.notes },
        include: PURCHASE_ORDER_INCLUDE,
      });
    });
  }

  // Only orders with nothing received can be cancelled; partially received ones are closed instead.
  async cancel(id: string, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const order = await this.lockOrder(tx, id, user);
      if (order.status !== PurchaseOrderStatus.open) throw this.invalidStatus(order.status);
      return tx.purchaseOrder.update({
        where: { id },
        data: { status: PurchaseOrderStatus.cancelled, closedAt: new Date() },
        include: PURCHASE_ORDER_INCLUDE,
      });
    });
  }

  // Ends a partially received order; the pending quantities will not arrive.
  async close(id: string, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const order = await this.lockOrder(tx, id, user);
      if (order.status !== PurchaseOrderStatus.partially_received) throw this.invalidStatus(order.status);
      return tx.purchaseOrder.update({
        where: { id },
        data: { status: PurchaseOrderStatus.closed, closedAt: new Date() },
        include: PURCHASE_ORDER_INCLUDE,
      });
    });
  }

  async lockOrder(tx: Tx, id: string, user: AuthUser) {
    await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${id} AND "tenantId" = ${requireTenantId()} FOR UPDATE`;
    const order = await tx.purchaseOrder.findUnique({ where: { id }, include: { items: true } });
    if (!order) throw new NotFoundException(NOT_FOUND);
    assertWarehouseAccess(user, order.warehouseId);
    return order;
  }

  private async assertSupplier(tx: Tx, supplierId: string) {
    const supplier = await tx.partner.findUnique({ where: { id: supplierId } });
    if (!supplier?.active || !supplier.isSupplier) {
      throw new NotFoundException({ error: 'SUPPLIER_NOT_FOUND', message: 'Proveedor no encontrado o inactivo' });
    }
  }

  private async assertWarehouse(tx: Tx, warehouseId: string) {
    const warehouse = await tx.warehouse.findUnique({ where: { id: warehouseId } });
    if (!warehouse?.active) throw new NotFoundException({ error: 'WAREHOUSE_NOT_FOUND', message: 'Almacén no encontrado o inactivo' });
  }

  private async assertItems(tx: Tx, items: PurchaseOrderItemDto[]) {
    const productIds = items.map((item) => item.productId);
    const duplicated = productIds.filter((id, index) => productIds.indexOf(id) !== index);
    if (duplicated.length > 0) {
      throw new UnprocessableEntityException({
        error: 'DUPLICATE_PRODUCT',
        message: 'Cada producto debe aparecer una sola vez en la orden',
        details: { productIds: [...new Set(duplicated)] },
      });
    }
    const found = await tx.product.findMany({ where: { id: { in: productIds }, active: true }, select: { id: true } });
    const missing = productIds.filter((id) => !found.some((product) => product.id === id));
    if (missing.length > 0) {
      throw new NotFoundException({ error: 'PRODUCT_NOT_FOUND', message: 'Productos no encontrados o inactivos', details: { productIds: missing } });
    }
  }

  private invalidStatus(status: PurchaseOrderStatus) {
    return new UnprocessableEntityException({
      error: 'PURCHASE_ORDER_INVALID_STATUS',
      message: `La orden de compra está ${status} y no admite este cambio`,
    });
  }
}
