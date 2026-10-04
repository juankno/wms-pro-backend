import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UploadsService } from '../uploads/uploads.service';
import { CreateProductDto } from './dto/create-product.dto';
import { ProductQueryDto } from './dto/product-query.dto';
import { paginate, buildMeta } from '../common/dto/pagination.dto';
import { Prisma, WarehouseStock } from '@prisma/client';
import { STOCK_STATUS_CONDITION, StockStatus } from '../stock/stock-status';

@Injectable()
export class ProductsService {
  constructor(
    private prisma: PrismaService,
    private uploads: UploadsService,
  ) {}

  async findAll(query: ProductQueryDto, warehouseId: string | undefined) {
    const { search, category, stockStatus, page, limit } = query;

    const where: Prisma.ProductWhereInput = { active: true };
    if (search) {
      where.OR = [
        { code: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
        { barcode: { contains: search, mode: 'insensitive' } },
        { brand: { contains: search, mode: 'insensitive' } },
        { category: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (category) where.category = { equals: category, mode: 'insensitive' };
    if (stockStatus) where.AND = [await this.stockStatusFilter(stockStatus, warehouseId)];

    const [products, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: { warehouseStock: warehouseId ? { where: { warehouseId } } : false },
        orderBy: { name: 'asc' },
        ...paginate(page, limit),
      }),
      this.prisma.product.count({ where }),
    ]);

    return { data: products.map((p) => this.attachStock(p, warehouseId)), meta: buildMeta(total, page, limit) };
  }

  // Products with no stock row in the warehouse count as out of stock.
  private async stockStatusFilter(status: StockStatus, warehouseId: string | undefined): Promise<Prisma.ProductWhereInput> {
    if (!warehouseId) {
      throw new BadRequestException({ error: 'WAREHOUSE_REQUIRED', message: 'Debes indicar el almacén para filtrar por estado de stock' });
    }
    const condition = status === 'out' ? Prisma.sql`NOT (${STOCK_STATUS_CONDITION.out})` : STOCK_STATUS_CONDITION[status];
    const rows = await this.prisma.$queryRaw<{ productId: string }[]>`
      SELECT "productId" FROM warehouse_stock WHERE "warehouseId" = ${warehouseId} AND ${condition}`;
    const ids = rows.map((r) => r.productId);
    return status === 'out' ? { id: { notIn: ids } } : { id: { in: ids } };
  }

  async findCategories(): Promise<string[]> {
    const rows = await this.prisma.product.findMany({
      where: { active: true, category: { not: '' } },
      distinct: ['category'],
      select: { category: true },
      orderBy: { category: 'asc' },
    });
    return rows.map((r) => r.category);
  }

  async findById(id: string, warehouseId: string | undefined) {
    const product = await this.prisma.product.findFirst({
      where: { id, active: true },
      include: {
        warehouseStock: {
          include: { warehouse: { select: { id: true, code: true, name: true, active: true } } },
          orderBy: { warehouse: { name: 'asc' } },
        },
      },
    });
    if (!product) throw new NotFoundException({ error: 'PRODUCT_NOT_FOUND', message: 'Producto no encontrado' });

    const userWs = warehouseId ? (product.warehouseStock.find((ws) => ws.warehouseId === warehouseId) ?? null) : null;
    const { warehouseStock, ...rest } = product;

    return {
      ...rest,
      warehouseStock: userWs
        ? {
            warehouseId,
            location: userWs.location,
            minStock: userWs.minStock,
            onHand: userWs.onHand,
            reserved: userWs.reserved,
            available: userWs.onHand - userWs.reserved,
          }
        : null,
      allWarehousesStock: warehouseStock.map((ws) => ({
        warehouse: ws.warehouse,
        onHand: ws.onHand,
        reserved: ws.reserved,
        available: ws.onHand - ws.reserved,
        minStock: ws.minStock,
        location: ws.location,
      })),
    };
  }

  async findByBarcode(barcode: string, warehouseId: string | undefined) {
    const product = await this.prisma.product.findFirst({
      where: { barcode, active: true },
      include: { warehouseStock: warehouseId ? { where: { warehouseId } } : false },
    });
    if (!product) throw new NotFoundException({ error: 'PRODUCT_NOT_FOUND', message: 'Producto no encontrado' });
    return this.attachStock(product, warehouseId);
  }

  async create(dto: CreateProductDto) {
    if (dto.barcode) {
      const exists = await this.prisma.product.findUnique({ where: { barcode: dto.barcode } });
      if (exists) throw new ConflictException({ error: 'BARCODE_DUPLICATE', message: 'Ya existe un producto con ese código de barras' });
    }
    return this.prisma.product.create({ data: dto });
  }

  async update(id: string, data: Partial<CreateProductDto>) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException({ error: 'PRODUCT_NOT_FOUND', message: 'Producto no encontrado' });

    if (data.barcode && data.barcode !== product.barcode) {
      const exists = await this.prisma.product.findUnique({ where: { barcode: data.barcode } });
      if (exists) throw new ConflictException({ error: 'BARCODE_DUPLICATE', message: 'Ya existe un producto con ese código de barras' });
    }

    return this.prisma.product.update({ where: { id }, data });
  }

  async softDelete(id: string) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException({ error: 'PRODUCT_NOT_FOUND', message: 'Producto no encontrado' });
    return this.prisma.product.update({ where: { id }, data: { active: false } });
  }

  async addPhoto(id: string, url: string) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException({ error: 'PRODUCT_NOT_FOUND', message: 'Producto no encontrado' });
    return this.prisma.product.update({
      where: { id },
      data: { photos: { push: url } },
    });
  }

  async removePhoto(id: string, photoUrl: string) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException({ error: 'PRODUCT_NOT_FOUND', message: 'Producto no encontrado' });
    const updated = await this.prisma.product.update({
      where: { id },
      data: { photos: product.photos.filter((p) => p !== photoUrl) },
    });
    this.uploads.deleteFile(photoUrl);
    return updated;
  }

  private attachStock<T extends { warehouseStock?: WarehouseStock[] }>(product: T, warehouseId: string | undefined) {
    const { warehouseStock, ...rest } = product;
    const ws = warehouseStock?.[0] ?? null;
    return {
      ...rest,
      warehouseStock: ws
        ? {
            warehouseId,
            location: ws.location,
            minStock: ws.minStock,
            onHand: ws.onHand,
            reserved: ws.reserved,
            available: ws.onHand - ws.reserved,
          }
        : null,
    };
  }
}
