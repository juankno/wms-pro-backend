import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { buildMeta, paginate } from '../common/dto/pagination.dto';

export interface AuditEntry {
  tenantId: string;
  actorId: string;
  actorName: string;
  action: string;
  resource: string;
  resourceId?: string;
  route: string;
  statusCode: number;
  payload?: unknown;
  requestId?: string;
  ip?: string;
}

@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}

  record(entry: AuditEntry) {
    const { payload, ...rest } = entry;
    return this.prisma.auditLog.create({
      data: { ...rest, payload: payload === undefined ? Prisma.DbNull : (payload as Prisma.InputJsonValue) },
    });
  }

  async findAll(opts: {
    actorId?: string;
    resource?: string;
    resourceId?: string;
    dateFrom?: string;
    dateTo?: string;
    page: number;
    limit: number;
  }) {
    const where: Prisma.AuditLogWhereInput = {
      actorId: opts.actorId,
      resource: opts.resource,
      resourceId: opts.resourceId,
    };
    if (opts.dateFrom || opts.dateTo) {
      where.createdAt = {
        ...(opts.dateFrom && { gte: new Date(opts.dateFrom) }),
        ...(opts.dateTo && { lte: new Date(opts.dateTo) }),
      };
    }

    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, ...paginate(opts.page, opts.limit) }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { data, meta: buildMeta(total, opts.page, opts.limit) };
  }
}
