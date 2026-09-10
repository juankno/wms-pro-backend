import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class WarehousesService {
  constructor(private prisma: PrismaService) {}

  findAll() {
    return this.prisma.warehouse.findMany({ where: { active: true } });
  }

  async findById(id: string) {
    const w = await this.prisma.warehouse.findUnique({ where: { id } });
    if (!w) throw new NotFoundException({ error: 'WAREHOUSE_NOT_FOUND', message: 'Almacén no encontrado' });
    return w;
  }

  create(data: { name: string; code: string; address?: string }) {
    return this.prisma.warehouse.create({ data });
  }

  async update(id: string, data: Partial<{ name: string; address: string; active: boolean }>) {
    await this.findById(id);
    return this.prisma.warehouse.update({ where: { id }, data });
  }
}
