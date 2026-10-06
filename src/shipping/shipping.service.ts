import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { OrderStatus, Prisma, ShipmentStatus } from '@prisma/client';
import { buildMeta, paginate } from '../common/dto/pagination.dto';
import { AuthUser } from '../common/types/request-with-user.interface';
import { assertWarehouseAccess } from '../common/utils/warehouse-scope';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenancy/tenant-context';

const SHIPMENT_INCLUDE = {
  carrier: { select: { id: true, name: true, trackingUrlTemplate: true } },
  packingOrder: { select: { id: true, reference: true, client: true, warehouseId: true, pickingOrderId: true } },
  shippedBy: { select: { id: true, name: true } },
} satisfies Prisma.ShipmentInclude;

type ShipmentWithRelations = Prisma.ShipmentGetPayload<{ include: typeof SHIPMENT_INCLUDE }>;

const NOT_FOUND = { error: 'SHIPMENT_NOT_FOUND', message: 'Despacho no encontrado' };

export const trackingUrl = (template: string | null | undefined, trackingNumber: string | null) =>
  template && trackingNumber ? template.replace('{tracking}', encodeURIComponent(trackingNumber)) : null;

const withTrackingUrl = (shipment: ShipmentWithRelations) => ({
  ...shipment,
  trackingUrl: trackingUrl(shipment.carrier?.trackingUrlTemplate, shipment.trackingNumber),
});

@Injectable()
export class ShippingService {
  constructor(private prisma: PrismaService) {}

  carriers(includeInactive = false) {
    return this.prisma.carrier.findMany({ where: includeInactive ? {} : { active: true }, orderBy: { name: 'asc' } });
  }

  createCarrier(data: { name: string; trackingUrlTemplate?: string }) {
    return this.prisma.carrier.create({ data: { ...data, tenantId: requireTenantId() } });
  }

  async updateCarrier(id: string, data: { name?: string; trackingUrlTemplate?: string | null; active?: boolean }) {
    const carrier = await this.prisma.carrier.findUnique({ where: { id } });
    if (!carrier) throw new NotFoundException({ error: 'CARRIER_NOT_FOUND', message: 'Transportadora no encontrada' });
    return this.prisma.carrier.update({ where: { id }, data });
  }

  async findAll(opts: {
    status?: ShipmentStatus;
    carrierId?: string;
    warehouseId?: string;
    search?: string;
    page: number;
    limit: number;
  }) {
    const where: Prisma.ShipmentWhereInput = {
      status: opts.status,
      carrierId: opts.carrierId,
      ...(opts.warehouseId && { packingOrder: { warehouseId: opts.warehouseId } }),
      ...(opts.search && {
        OR: [
          { trackingNumber: { contains: opts.search, mode: 'insensitive' } },
          { packingOrder: { reference: { contains: opts.search, mode: 'insensitive' } } },
          { packingOrder: { client: { contains: opts.search, mode: 'insensitive' } } },
        ],
      }),
    };
    const [data, total] = await Promise.all([
      this.prisma.shipment.findMany({ where, include: SHIPMENT_INCLUDE, orderBy: { shippedAt: 'desc' }, ...paginate(opts.page, opts.limit) }),
      this.prisma.shipment.count({ where }),
    ]);
    return { data: data.map(withTrackingUrl), meta: buildMeta(total, opts.page, opts.limit) };
  }

  async findById(id: string, user: AuthUser) {
    const shipment = await this.prisma.shipment.findUnique({ where: { id }, include: SHIPMENT_INCLUDE });
    if (!shipment) throw new NotFoundException(NOT_FOUND);
    assertWarehouseAccess(user, shipment.packingOrder.warehouseId);
    return withTrackingUrl(shipment);
  }

  // A completed packing leaves the warehouse once; the carrier name is kept even if the carrier changes later.
  async ship(
    packingOrderId: string,
    dto: { carrierId?: string; carrierName?: string; trackingNumber?: string; notes?: string },
    user: AuthUser,
  ) {
    const packing = await this.prisma.packingOrder.findUnique({ where: { id: packingOrderId }, include: { shipment: true } });
    if (!packing) throw new NotFoundException({ error: 'ORDER_NOT_FOUND', message: 'Orden de packing no encontrada' });
    assertWarehouseAccess(user, packing.warehouseId);
    if (packing.status !== OrderStatus.completed) {
      throw new UnprocessableEntityException({ error: 'PACKING_NOT_COMPLETED', message: 'Solo se despachan packings completados' });
    }
    if (packing.shipment) throw new ConflictException({ error: 'ALREADY_SHIPPED', message: 'El packing ya fue despachado' });

    let carrierName = dto.carrierName;
    if (dto.carrierId) {
      const carrier = await this.prisma.carrier.findUnique({ where: { id: dto.carrierId } });
      if (!carrier?.active) throw new NotFoundException({ error: 'CARRIER_NOT_FOUND', message: 'Transportadora no encontrada o inactiva' });
      carrierName = carrier.name;
    }

    const shipment = await this.prisma.shipment.create({
      data: {
        tenantId: requireTenantId(),
        packingOrderId,
        carrierId: dto.carrierId,
        carrierName,
        trackingNumber: dto.trackingNumber?.trim(),
        notes: dto.notes,
        shippedById: user.id,
      },
    });
    return this.findById(shipment.id, user);
  }

  async deliver(id: string, dto: { receivedBy: string; proofPhotoUrl?: string; deliveredAt?: string }, user: AuthUser) {
    const shipment = await this.findById(id, user);
    if (shipment.status !== ShipmentStatus.shipped) {
      throw new UnprocessableEntityException({ error: 'ALREADY_DELIVERED', message: 'El despacho ya se registró como entregado' });
    }
    await this.prisma.shipment.update({
      where: { id },
      data: {
        status: ShipmentStatus.delivered,
        deliveredAt: dto.deliveredAt ? new Date(dto.deliveredAt) : new Date(),
        receivedBy: dto.receivedBy,
        proofPhotoUrl: dto.proofPhotoUrl,
      },
    });
    return this.findById(id, user);
  }
}
