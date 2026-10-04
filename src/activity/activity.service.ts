import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { paginate, buildMeta } from '../common/dto/pagination.dto';
import { requireTenantId } from '../tenancy/tenant-context';

@Injectable()
export class ActivityService {
  constructor(private prisma: PrismaService) {}

  async log(
    data: {
      orderId: string;
      orderType: 'picking' | 'packing';
      action: string;
      detail: string;
      operator: string;
      userId: string;
      warehouseId: string;
    },
    db: Prisma.TransactionClient = this.prisma,
  ) {
    return db.activityLog.create({ data: { ...data, tenantId: requireTenantId() } });
  }

  async findAll(page: number, limit: number, warehouseId?: string) {
    const where = warehouseId ? { warehouseId } : {};
    const [data, total] = await Promise.all([
      this.prisma.activityLog.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        ...paginate(page, limit),
      }),
      this.prisma.activityLog.count({ where }),
    ]);
    return { data, meta: buildMeta(total, page, limit) };
  }

  async findByOrder(orderId: string) {
    return this.prisma.activityLog.findMany({
      where: { orderId },
      orderBy: { timestamp: 'asc' },
    });
  }
}
