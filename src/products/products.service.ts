import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProductDto } from './dto/create-product.dto';
import { ProductQueryDto } from './dto/product-query.dto';
import { paginate, buildMeta } from '../common/dto/pagination.dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class ProductsService {
  constructor(private prisma: PrismaService) {}

  async findAll(query: ProductQueryDto, defaultWarehouseId: string) {
    const { search, category, stockStatus, warehouseId, page, limit } = query;
    const wId = warehouseId ?? defaultWarehouseId;

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

    const [products, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: { warehouseStock: { where: { warehouseId: wId } } },
        orderBy: { name: 'asc' },
        ...paginate(page, limit),
      }),
      this.prisma.product.count({ where }),
    ]);

    let data = products.map((p) => this.attachStock(p, wId));

    if (stockStatus) {
      data = data.filter((p) => {
        const ws = p.warehouseStock;
        if (!ws) return stockStatus === 'out';
        const avail = ws.stockDisponible;
        if (stockStatus === 'out') return avail === 0;
        if (stockStatus === 'low') return avail > 0 && avail <= ws.minStock;
        return avail > ws.minStock;
      });
    }

    return { data, meta: buildMeta(total, page, limit) };
  }

  async findById(id: string, warehouseId: string) {
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

    const userWs = product.warehouseStock.find((ws) => ws.warehouseId === warehouseId) ?? null;
    const { warehouseStock, ...rest } = product;

    return {
      ...rest,
      warehouseStock: userWs
        ? {
            warehouseId,
            location: userWs.location,
            minStock: userWs.minStock,
            stockFisico: userWs.stockFisico,
            stockReservado: userWs.stockReservado,
            stockDisponible: userWs.stockFisico - userWs.stockReservado,
          }
        : null,
      allWarehousesStock: warehouseStock.map((ws) => ({
        warehouse: ws.warehouse,
        stockFisico: ws.stockFisico,
        stockReservado: ws.stockReservado,
        stockDisponible: ws.stockFisico - ws.stockReservado,
        minStock: ws.minStock,
        location: ws.location,
      })),
    };
  }

  async findByBarcode(barcode: string, warehouseId: string) {
    const product = await this.prisma.product.findFirst({
      where: { barcode, active: true },
      include: { warehouseStock: { where: { warehouseId } } },
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
    return this.prisma.product.update({
      where: { id },
      data: { photos: product.photos.filter((p) => p !== photoUrl) },
    });
  }

  private attachStock(product: any, warehouseId: string) {
    const ws = product.warehouseStock?.[0] ?? null;
    const { warehouseStock: _ws, ...rest } = product;
    return {
      ...rest,
      warehouseStock: ws
        ? {
            warehouseId,
            location: ws.location,
            minStock: ws.minStock,
            stockFisico: ws.stockFisico,
            stockReservado: ws.stockReservado,
            stockDisponible: ws.stockFisico - ws.stockReservado,
          }
        : null,
    };
  }
}
