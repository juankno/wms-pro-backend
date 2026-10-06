import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { AuthUser } from '../common/types/request-with-user.interface';
import { assertWarehouseAccess } from '../common/utils/warehouse-scope';
import { PrismaService } from '../prisma/prisma.service';
import { LabelContent, locationLabel, productLabel, shippingLabels } from './label-content';

export const MAX_LABELS = 500;

@Injectable()
export class LabelsService {
  constructor(private prisma: PrismaService) {}

  async products(ids: string[]): Promise<LabelContent[]> {
    this.assertCount(ids.length);
    const products = await this.prisma.product.findMany({ where: { id: { in: ids } }, orderBy: { code: 'asc' } });
    if (products.length === 0) throw new NotFoundException({ error: 'PRODUCT_NOT_FOUND', message: 'Productos no encontrados' });
    return products.map(productLabel);
  }

  // Either explicit ids or every location under a parent (or the whole warehouse), in walking order.
  async locations(opts: { ids?: string[]; warehouseId?: string; parentId?: string }, user: AuthUser): Promise<LabelContent[]> {
    if (!opts.ids?.length && !opts.warehouseId) {
      throw new UnprocessableEntityException({ error: 'LABELS_SCOPE_REQUIRED', message: 'Indica las ubicaciones o el almacén' });
    }
    const locations = await this.prisma.location.findMany({
      where: opts.ids?.length
        ? { id: { in: opts.ids } }
        : { warehouseId: opts.warehouseId, active: true, ...(opts.parentId && { parentId: opts.parentId }) },
      include: { warehouse: { select: { code: true } } },
      orderBy: [{ pickSequence: 'asc' }, { code: 'asc' }],
      take: MAX_LABELS + 1,
    });
    this.assertCount(locations.length);
    if (locations.length === 0) throw new NotFoundException({ error: 'LOCATION_NOT_FOUND', message: 'Ubicaciones no encontradas' });
    for (const warehouseId of new Set(locations.map((location) => location.warehouseId))) assertWarehouseAccess(user, warehouseId);
    return locations.map((location) => locationLabel(location, location.warehouse.code));
  }

  async packing(id: string, user: AuthUser): Promise<LabelContent[]> {
    const packing = await this.prisma.packingOrder.findUnique({
      where: { id },
      include: { boxes: { orderBy: { label: 'asc' } }, shipment: { select: { trackingNumber: true } } },
    });
    if (!packing) throw new NotFoundException({ error: 'ORDER_NOT_FOUND', message: 'Orden de packing no encontrada' });
    assertWarehouseAccess(user, packing.warehouseId);
    return shippingLabels({ ...packing, trackingNumber: packing.shipment?.trackingNumber });
  }

  private assertCount(count: number) {
    if (count > MAX_LABELS) {
      throw new UnprocessableEntityException({
        error: 'TOO_MANY_LABELS',
        message: `Se pueden imprimir hasta ${MAX_LABELS} etiquetas por solicitud`,
      });
    }
  }
}
