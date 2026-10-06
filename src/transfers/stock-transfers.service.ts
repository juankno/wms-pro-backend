import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, StockTransferStatus } from '@prisma/client';
import { buildMeta, paginate } from '../common/dto/pagination.dto';
import { AuthUser } from '../common/types/request-with-user.interface';
import { assertWarehouseAccess } from '../common/utils/warehouse-scope';
import { PrismaService } from '../prisma/prisma.service';
import { nextReference } from '../sequences/sequence';
import { allocateOutbound, putAway } from '../stock/location-stock';
import { addToLots, LotAllocation, singleLot, takeFromLots } from '../stock/lot-stock';
import { lockWarehouseStock } from '../stock/stock-lock';
import { requireTenantId } from '../tenancy/tenant-context';

type Tx = Prisma.TransactionClient;

const TRANSFER_INCLUDE = {
  fromWarehouse: { select: { id: true, code: true, name: true } },
  toWarehouse: { select: { id: true, code: true, name: true } },
  sentBy: { select: { id: true, name: true } },
  receivedBy: { select: { id: true, name: true } },
  items: { include: { product: { select: { id: true, code: true, name: true, unit: true } } } },
} satisfies Prisma.StockTransferInclude;

const NOT_FOUND = { error: 'TRANSFER_NOT_FOUND', message: 'Traslado no encontrado' };

const canSee = (user: AuthUser, warehouseIds: string[]) =>
  user.permissions.includes('warehouses.all') || (user.warehouseId !== null && warehouseIds.includes(user.warehouseId));

// Splits a received quantity over the lots that left the origin, in the order they were taken.
export function receivedLots(allocations: LotAllocation[], quantity: number): LotAllocation[] {
  const result: LotAllocation[] = [];
  let left = quantity;
  for (const allocation of allocations) {
    if (left === 0) break;
    const taken = Math.min(allocation.quantity, left);
    result.push({ lotId: allocation.lotId, quantity: taken });
    left -= taken;
  }
  return result;
}

@Injectable()
export class StockTransfersService {
  constructor(private prisma: PrismaService) {}

  async findAll(opts: { status?: StockTransferStatus; warehouseId?: string; page: number; limit: number }) {
    const where: Prisma.StockTransferWhereInput = {
      status: opts.status,
      ...(opts.warehouseId && { OR: [{ fromWarehouseId: opts.warehouseId }, { toWarehouseId: opts.warehouseId }] }),
    };
    const [data, total] = await Promise.all([
      this.prisma.stockTransfer.findMany({ where, include: TRANSFER_INCLUDE, orderBy: { sentAt: 'desc' }, ...paginate(opts.page, opts.limit) }),
      this.prisma.stockTransfer.count({ where }),
    ]);
    return { data, meta: buildMeta(total, opts.page, opts.limit) };
  }

  async findById(id: string, user: AuthUser) {
    const transfer = await this.prisma.stockTransfer.findUnique({ where: { id }, include: TRANSFER_INCLUDE });
    if (!transfer) throw new NotFoundException(NOT_FOUND);
    if (!canSee(user, [transfer.fromWarehouseId, transfer.toWarehouseId])) {
      throw new ForbiddenException({ error: 'WAREHOUSE_FORBIDDEN', message: 'No tienes acceso a este almacén' });
    }
    return transfer;
  }

  // Units leave the origin now (by location and lot) and stay in transit until received.
  async send(
    dto: {
      fromWarehouseId: string;
      toWarehouseId: string;
      notes?: string;
      items: { productId: string; quantity: number; fromLocationId?: string; lotId?: string }[];
    },
    user: AuthUser,
  ) {
    assertWarehouseAccess(user, dto.fromWarehouseId);
    if (dto.fromWarehouseId === dto.toWarehouseId) {
      throw new BadRequestException({ error: 'SAME_WAREHOUSE', message: 'El almacén origen y destino deben ser distintos' });
    }
    const productIds = dto.items.map((item) => item.productId);
    if (new Set(productIds).size !== productIds.length) {
      throw new UnprocessableEntityException({ error: 'DUPLICATE_PRODUCT', message: 'Cada producto debe aparecer una sola vez' });
    }

    const transfer = await this.prisma.$transaction(
      async (tx) => {
        const destination = await tx.warehouse.findUnique({ where: { id: dto.toWarehouseId } });
        if (!destination?.active) {
          throw new NotFoundException({ error: 'WAREHOUSE_NOT_FOUND', message: 'El almacén destino no existe o está inactivo' });
        }
        const reference = await nextReference(tx, 'transfer', async (candidate) => !!(await tx.stockTransfer.findFirst({ where: { reference: candidate } })));
        const created = await tx.stockTransfer.create({
          data: {
            tenantId: requireTenantId(),
            reference,
            fromWarehouseId: dto.fromWarehouseId,
            toWarehouseId: dto.toWarehouseId,
            notes: dto.notes,
            sentById: user.id,
          },
        });
        for (const item of [...dto.items].sort((a, b) => a.productId.localeCompare(b.productId))) {
          const lots = await this.takeFromOrigin(tx, created.id, reference, dto.fromWarehouseId, item, user);
          await tx.stockTransferItem.create({
            data: { transferId: created.id, productId: item.productId, quantity: item.quantity, lotAllocations: lots as unknown as Prisma.InputJsonValue },
          });
        }
        return created;
      },
      { timeout: 60_000 },
    );
    return this.findById(transfer.id, user);
  }

  // Receives everything unless quantities are given; missing units are recorded as a difference.
  async receive(id: string, dto: { items?: { itemId: string; receivedQuantity: number; locationId?: string }[] }, user: AuthUser) {
    await this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM stock_transfers WHERE id = ${id} AND "tenantId" = ${requireTenantId()} FOR UPDATE`;
        const transfer = await tx.stockTransfer.findUnique({ where: { id }, include: { items: true } });
        if (!transfer) throw new NotFoundException(NOT_FOUND);
        assertWarehouseAccess(user, transfer.toWarehouseId);
        if (transfer.status !== StockTransferStatus.in_transit) {
          throw new UnprocessableEntityException({ error: 'TRANSFER_ALREADY_RECEIVED', message: 'El traslado ya fue recibido' });
        }

        for (const item of [...transfer.items].sort((a, b) => a.productId.localeCompare(b.productId))) {
          const input = dto.items?.find((entry) => entry.itemId === item.id);
          const received = input?.receivedQuantity ?? item.quantity;
          if (received > item.quantity) {
            throw new UnprocessableEntityException({
              error: 'QUANTITY_EXCEEDED',
              message: 'No se puede recibir más de lo enviado',
              details: { itemId: item.id, sent: item.quantity, received },
            });
          }
          if (received > 0) await this.putIntoDestination(tx, transfer, item, received, input?.locationId, user);
          await tx.stockTransferItem.update({ where: { id: item.id }, data: { receivedQuantity: received } });
        }
        await tx.stockTransfer.update({
          where: { id },
          data: { status: StockTransferStatus.received, receivedById: user.id, receivedAt: new Date() },
        });
      },
      { timeout: 60_000 },
    );
    return this.findById(id, user);
  }

  private async takeFromOrigin(
    tx: Tx,
    transferId: string,
    reference: string,
    warehouseId: string,
    item: { productId: string; quantity: number; fromLocationId?: string; lotId?: string },
    user: AuthUser,
  ): Promise<LotAllocation[]> {
    const stock = await lockWarehouseStock(tx, item.productId, warehouseId);
    if (!stock) throw new NotFoundException({ error: 'PRODUCT_NOT_FOUND', message: 'El producto no existe en el almacén origen' });
    const available = stock.onHand - stock.reserved;
    if (available < item.quantity) {
      throw new ConflictException({
        error: 'INSUFFICIENT_STOCK',
        message: 'Stock disponible insuficiente en el almacén origen',
        details: [{ productId: item.productId, requested: item.quantity, available }],
      });
    }
    const locations = await allocateOutbound(tx, stock, item.quantity, item.fromLocationId);
    const lots = await takeFromLots(tx, stock, item.quantity, item.lotId);
    const onHandAfter = stock.onHand - item.quantity;
    await tx.warehouseStock.update({ where: { id: stock.id }, data: { onHand: onHandAfter } });
    await tx.stockMovement.create({
      data: {
        tenantId: requireTenantId(),
        productId: item.productId,
        warehouseId,
        type: 'transfer_out',
        quantity: item.quantity,
        onHandBefore: stock.onHand,
        onHandAfter,
        reservedBefore: stock.reserved,
        reservedAfter: stock.reserved,
        referenceType: 'stock_transfer',
        referenceId: transferId,
        notes: `Traslado ${reference} en tránsito`,
        operatorId: user.id,
        operatorName: user.name,
        locationId: locations.length === 1 ? (locations[0].locationId ?? undefined) : undefined,
        lotId: singleLot(lots),
      },
    });
    return lots;
  }

  private async putIntoDestination(
    tx: Tx,
    transfer: { id: string; reference: string; toWarehouseId: string },
    item: { productId: string; lotAllocations: Prisma.JsonValue },
    quantity: number,
    locationId: string | undefined,
    user: AuthUser,
  ) {
    const tenantId = requireTenantId();
    await tx.warehouseStock.upsert({
      where: { productId_warehouseId: { productId: item.productId, warehouseId: transfer.toWarehouseId } },
      create: { tenantId, productId: item.productId, warehouseId: transfer.toWarehouseId },
      update: {},
    });
    const stock = (await lockWarehouseStock(tx, item.productId, transfer.toWarehouseId))!;
    if (locationId) await putAway(tx, stock, locationId, quantity);
    const lots = receivedLots(item.lotAllocations as unknown as LotAllocation[], quantity);
    await addToLots(tx, stock, lots);
    const onHandAfter = stock.onHand + quantity;
    await tx.warehouseStock.update({ where: { id: stock.id }, data: { onHand: onHandAfter } });
    await tx.stockMovement.create({
      data: {
        tenantId,
        productId: item.productId,
        warehouseId: transfer.toWarehouseId,
        type: 'transfer_in',
        quantity,
        onHandBefore: stock.onHand,
        onHandAfter,
        reservedBefore: stock.reserved,
        reservedAfter: stock.reserved,
        referenceType: 'stock_transfer',
        referenceId: transfer.id,
        notes: `Recepción del traslado ${transfer.reference}`,
        operatorId: user.id,
        operatorName: user.name,
        locationId,
        lotId: singleLot(lots),
      },
    });
  }
}
