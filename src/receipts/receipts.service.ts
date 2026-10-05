import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, PurchaseOrderStatus, ReceiptStatus } from '@prisma/client';
import { buildMeta, paginate } from '../common/dto/pagination.dto';
import { AuthUser } from '../common/types/request-with-user.interface';
import { assertWarehouseAccess } from '../common/utils/warehouse-scope';
import { PrismaService } from '../prisma/prisma.service';
import { putAway } from '../stock/location-stock';
import { receiveIntoLot } from '../stock/lot-stock';
import { lockWarehouseStock, sumByProduct } from '../stock/stock-lock';
import { requireTenantId } from '../tenancy/tenant-context';
import { AddReceiptLineDto, CreateReceiptDto } from './dto/receipt.dto';

type Tx = Prisma.TransactionClient;

const RECEIPT_INCLUDE = {
  purchaseOrder: { select: { id: true, reference: true, status: true } },
  supplier: { select: { id: true, code: true, name: true } },
  warehouse: { select: { id: true, code: true, name: true } },
  lines: {
    include: {
      product: { select: { id: true, code: true, name: true, unit: true, lotTracking: true } },
      location: { select: { id: true, code: true } },
    },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.ReceiptInclude;

const RECEIVABLE_ORDER_STATUSES: PurchaseOrderStatus[] = [PurchaseOrderStatus.open, PurchaseOrderStatus.partially_received];
const NOT_FOUND = { error: 'RECEIPT_NOT_FOUND', message: 'Recepción no encontrada' };

@Injectable()
export class ReceiptsService {
  constructor(private prisma: PrismaService) {}

  async findAll(opts: { status?: ReceiptStatus; warehouseId?: string; purchaseOrderId?: string; page: number; limit: number }) {
    const where: Prisma.ReceiptWhereInput = {
      status: opts.status,
      warehouseId: opts.warehouseId,
      purchaseOrderId: opts.purchaseOrderId,
    };
    const [data, total] = await Promise.all([
      this.prisma.receipt.findMany({ where, include: RECEIPT_INCLUDE, orderBy: { createdAt: 'desc' }, ...paginate(opts.page, opts.limit) }),
      this.prisma.receipt.count({ where }),
    ]);
    return { data, meta: buildMeta(total, opts.page, opts.limit) };
  }

  // Includes, for receipts against an order, what was ordered, received before and still pending.
  async findById(id: string, user: AuthUser) {
    const receipt = await this.prisma.receipt.findUnique({ where: { id }, include: RECEIPT_INCLUDE });
    if (!receipt) throw new NotFoundException(NOT_FOUND);
    assertWarehouseAccess(user, receipt.warehouseId);

    const incoming = sumByProduct(receipt.lines, (line) => line.quantity);
    const items = receipt.purchaseOrderId
      ? await this.prisma.purchaseOrderItem.findMany({
          where: { purchaseOrderId: receipt.purchaseOrderId },
          include: { product: { select: { id: true, code: true, name: true, unit: true } } },
        })
      : [];
    const expected = items.map((item) => ({
      product: item.product,
      ordered: item.quantity,
      previouslyReceived: item.receivedQuantity,
      inThisReceipt: receipt.status === ReceiptStatus.open ? (incoming.get(item.productId) ?? 0) : 0,
      pending: Math.max(0, item.quantity - item.receivedQuantity),
    }));

    const lines = await Promise.all(
      receipt.lines.map(async (line) => ({
        ...line,
        suggestedLocation:
          !line.locationId && receipt.status === ReceiptStatus.open
            ? await this.suggestPutaway(line.productId, receipt.warehouseId, line.quantity)
            : null,
      })),
    );
    return { ...receipt, lines, expected };
  }

  async create(dto: CreateReceiptDto, user: AuthUser) {
    let warehouseId = dto.warehouseId;
    let supplierId = dto.supplierId;
    if (dto.purchaseOrderId) {
      const order = await this.prisma.purchaseOrder.findUnique({ where: { id: dto.purchaseOrderId } });
      if (!order) throw new NotFoundException({ error: 'PURCHASE_ORDER_NOT_FOUND', message: 'Orden de compra no encontrada' });
      if (!RECEIVABLE_ORDER_STATUSES.includes(order.status)) {
        throw new UnprocessableEntityException({
          error: 'PURCHASE_ORDER_INVALID_STATUS',
          message: `La orden de compra está ${order.status} y no admite recepciones`,
        });
      }
      warehouseId = order.warehouseId;
      supplierId = order.supplierId;
    } else if (supplierId) {
      const supplier = await this.prisma.partner.findUnique({ where: { id: supplierId } });
      if (!supplier?.active || !supplier.isSupplier) {
        throw new NotFoundException({ error: 'SUPPLIER_NOT_FOUND', message: 'Proveedor no encontrado o inactivo' });
      }
    }
    if (!warehouseId) {
      throw new UnprocessableEntityException({ error: 'WAREHOUSE_REQUIRED', message: 'Indica el almacén de la recepción' });
    }
    assertWarehouseAccess(user, warehouseId);
    const warehouse = await this.prisma.warehouse.findUnique({ where: { id: warehouseId } });
    if (!warehouse?.active) throw new NotFoundException({ error: 'WAREHOUSE_NOT_FOUND', message: 'Almacén no encontrado o inactivo' });

    const receipt = await this.prisma.receipt.create({
      data: {
        tenantId: requireTenantId(),
        purchaseOrderId: dto.purchaseOrderId,
        supplierId,
        warehouseId,
        notes: dto.notes,
        createdById: user.id,
      },
    });
    return this.findById(receipt.id, user);
  }

  async addLine(id: string, dto: AddReceiptLineDto, user: AuthUser) {
    const { line, warehouseId } = await this.prisma.$transaction(async (tx) => {
      const receipt = await this.lockOpenReceipt(tx, id, user);
      const product = await tx.product.findFirst({ where: { id: dto.productId, active: true } });
      if (!product) throw new NotFoundException({ error: 'PRODUCT_NOT_FOUND', message: 'Producto no encontrado o inactivo' });

      if (receipt.purchaseOrderId) {
        const ordered = await tx.purchaseOrderItem.findUnique({
          where: { purchaseOrderId_productId: { purchaseOrderId: receipt.purchaseOrderId, productId: product.id } },
        });
        if (!ordered) {
          throw new UnprocessableEntityException({
            error: 'PRODUCT_NOT_IN_ORDER',
            message: `${product.code} no está en la orden de compra`,
          });
        }
      }
      if (product.lotTracking && !dto.lot) {
        throw new UnprocessableEntityException({ error: 'LOT_REQUIRED', message: `${product.code} maneja lotes; indica el lote` });
      }
      if (!product.lotTracking && dto.lot) {
        throw new UnprocessableEntityException({ error: 'PRODUCT_NOT_LOT_TRACKED', message: 'El producto no maneja lotes' });
      }
      if (dto.locationId) await this.assertStorableLocation(tx, dto.locationId, receipt.warehouseId);

      const created = await tx.receiptLine.create({
        data: {
          receiptId: id,
          productId: product.id,
          quantity: dto.quantity,
          locationId: dto.locationId,
          lotCode: dto.lot?.trim().toUpperCase(),
          lotExpiresAt: dto.lotExpiresAt ? new Date(dto.lotExpiresAt) : undefined,
        },
        include: { product: { select: { id: true, code: true, name: true, unit: true } }, location: { select: { id: true, code: true } } },
      });
      return { line: created, warehouseId: receipt.warehouseId };
    });
    return {
      ...line,
      suggestedLocation: line.locationId ? null : await this.suggestPutaway(line.productId, warehouseId, line.quantity),
    };
  }

  async removeLine(id: string, lineId: string, user: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      await this.lockOpenReceipt(tx, id, user);
      const { count } = await tx.receiptLine.deleteMany({ where: { id: lineId, receiptId: id } });
      if (count === 0) throw new NotFoundException({ error: 'RECEIPT_LINE_NOT_FOUND', message: 'Línea no encontrada' });
    });
  }

  async cancel(id: string, user: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      await this.lockOpenReceipt(tx, id, user);
      await tx.receipt.update({ where: { id }, data: { status: ReceiptStatus.cancelled } });
    });
    return this.findById(id, user);
  }

  // Posts every line to stock in one transaction and updates the purchase order it belongs to.
  async complete(id: string, allowOverReceipt: boolean, user: AuthUser) {
    const differences = await this.prisma.$transaction(
      async (tx) => {
        const receipt = await this.lockOpenReceipt(tx, id, user);
        const lines = await tx.receiptLine.findMany({ where: { receiptId: id }, orderBy: { productId: 'asc' } });
        if (lines.length === 0) {
          throw new UnprocessableEntityException({ error: 'RECEIPT_EMPTY', message: 'La recepción no tiene líneas' });
        }
        const incoming = sumByProduct(lines, (line) => line.quantity);
        const order = receipt.purchaseOrderId ? await this.lockOrder(tx, receipt.purchaseOrderId) : null;

        if (order) {
          const over = order.items
            .map((item) => ({ productId: item.productId, ordered: item.quantity, receiving: item.receivedQuantity + (incoming.get(item.productId) ?? 0) }))
            .filter((item) => item.receiving > item.ordered);
          if (over.length > 0 && !allowOverReceipt) {
            throw new UnprocessableEntityException({
              error: 'OVER_RECEIPT',
              message: 'Se recibe más de lo pedido; confirma para aceptar el excedente',
              details: over,
            });
          }
        }

        for (const line of lines) await this.postLine(tx, receipt, line, order?.reference, user);
        await tx.receipt.update({ where: { id }, data: { status: ReceiptStatus.completed, completedAt: new Date() } });

        if (order) {
          for (const item of order.items) {
            const received = incoming.get(item.productId) ?? 0;
            if (received > 0) {
              await tx.purchaseOrderItem.update({ where: { id: item.id }, data: { receivedQuantity: { increment: received } } });
            }
          }
          const items = await tx.purchaseOrderItem.findMany({ where: { purchaseOrderId: order.id } });
          const complete = items.every((item) => item.receivedQuantity >= item.quantity);
          await tx.purchaseOrder.update({
            where: { id: order.id },
            data: {
              status: complete ? PurchaseOrderStatus.received : PurchaseOrderStatus.partially_received,
              closedAt: complete ? new Date() : undefined,
            },
          });
          return items.map((item) => ({
            productId: item.productId,
            ordered: item.quantity,
            received: item.receivedQuantity,
            pending: Math.max(0, item.quantity - item.receivedQuantity),
            over: Math.max(0, item.receivedQuantity - item.quantity),
          }));
        }

        return [...incoming].map(([productId, received]) => ({ productId, ordered: null, received, pending: 0, over: 0 }));
      },
      { timeout: 60_000 },
    );
    return { receipt: await this.findById(id, user), differences };
  }

  private async postLine(
    tx: Tx,
    receipt: { id: string; warehouseId: string },
    line: { productId: string; quantity: number; locationId: string | null; lotCode: string | null; lotExpiresAt: Date | null },
    orderReference: string | undefined,
    user: AuthUser,
  ) {
    const tenantId = requireTenantId();
    await tx.warehouseStock.upsert({
      where: { productId_warehouseId: { productId: line.productId, warehouseId: receipt.warehouseId } },
      create: { tenantId, productId: line.productId, warehouseId: receipt.warehouseId },
      update: {},
    });
    const stock = (await lockWarehouseStock(tx, line.productId, receipt.warehouseId))!;
    if (line.locationId) await putAway(tx, stock, line.locationId, line.quantity);
    const lotId = await receiveIntoLot(
      tx,
      stock,
      line.quantity,
      line.lotCode ? { code: line.lotCode, expiresAt: line.lotExpiresAt ?? undefined } : undefined,
    );
    await tx.warehouseStock.update({ where: { id: stock.id }, data: { onHand: stock.onHand + line.quantity } });
    await tx.stockMovement.create({
      data: {
        tenantId,
        productId: line.productId,
        warehouseId: receipt.warehouseId,
        type: 'purchase_receipt',
        quantity: line.quantity,
        onHandBefore: stock.onHand,
        onHandAfter: stock.onHand + line.quantity,
        reservedBefore: stock.reserved,
        reservedAfter: stock.reserved,
        referenceType: 'receipt',
        referenceId: receipt.id,
        notes: orderReference ? `Recepción de ${orderReference}` : 'Recepción sin orden',
        operatorId: user.id,
        operatorName: user.name,
        locationId: line.locationId,
        lotId,
      },
    });
  }

  // Where the product already lives (most units first) with room for the quantity.
  async suggestPutaway(productId: string, warehouseId: string, quantity: number) {
    const rows = await this.prisma.locationStock.findMany({
      where: { productId, warehouseId, quantity: { gt: 0 }, location: { active: true, storable: true } },
      include: { location: { select: { id: true, code: true, capacity: true } } },
      orderBy: { quantity: 'desc' },
    });
    for (const row of rows) {
      if (row.location.capacity === null) return { id: row.location.id, code: row.location.code };
      const { _sum } = await this.prisma.locationStock.aggregate({ where: { locationId: row.locationId }, _sum: { quantity: true } });
      if ((_sum.quantity ?? 0) + quantity <= row.location.capacity) return { id: row.location.id, code: row.location.code };
    }
    return null;
  }

  private async lockOpenReceipt(tx: Tx, id: string, user: AuthUser) {
    await tx.$queryRaw`SELECT id FROM receipts WHERE id = ${id} AND "tenantId" = ${requireTenantId()} FOR UPDATE`;
    const receipt = await tx.receipt.findUnique({ where: { id } });
    if (!receipt) throw new NotFoundException(NOT_FOUND);
    assertWarehouseAccess(user, receipt.warehouseId);
    if (receipt.status !== ReceiptStatus.open) {
      throw new UnprocessableEntityException({ error: 'RECEIPT_INVALID_STATUS', message: `La recepción está ${receipt.status}` });
    }
    return receipt;
  }

  private async lockOrder(tx: Tx, id: string) {
    await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${id} AND "tenantId" = ${requireTenantId()} FOR UPDATE`;
    const order = await tx.purchaseOrder.findUniqueOrThrow({ where: { id }, include: { items: true } });
    if (!RECEIVABLE_ORDER_STATUSES.includes(order.status)) {
      throw new UnprocessableEntityException({
        error: 'PURCHASE_ORDER_INVALID_STATUS',
        message: `La orden de compra está ${order.status} y no admite recepciones`,
      });
    }
    return order;
  }

  private async assertStorableLocation(tx: Tx, locationId: string, warehouseId: string) {
    const location = await tx.location.findUnique({ where: { id: locationId } });
    if (!location || location.warehouseId !== warehouseId || !location.active) {
      throw new NotFoundException({ error: 'LOCATION_NOT_FOUND', message: 'Ubicación no encontrada en el almacén' });
    }
    if (!location.storable) {
      throw new UnprocessableEntityException({ error: 'LOCATION_NOT_STORABLE', message: `La ubicación ${location.code} no admite stock` });
    }
  }
}
