import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { buildMeta, paginate } from '../common/dto/pagination.dto';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenancy/tenant-context';
import { CreatePartnerDto, PartnerKind, PartnerQueryDto, UpdatePartnerDto } from './dto/partner.dto';

const KIND_FILTER: Record<PartnerKind, Prisma.PartnerWhereInput> = {
  customer: { isCustomer: true },
  supplier: { isSupplier: true },
};

const NOT_FOUND = { error: 'PARTNER_NOT_FOUND', message: 'Cliente o proveedor no encontrado' };

@Injectable()
export class PartnersService {
  constructor(private prisma: PrismaService) {}

  async findAll(query: PartnerQueryDto) {
    const where: Prisma.PartnerWhereInput = {
      ...(query.kind && KIND_FILTER[query.kind]),
      ...(!query.includeInactive && { active: true }),
      ...(query.search && {
        OR: [
          { code: { contains: query.search, mode: 'insensitive' } },
          { name: { contains: query.search, mode: 'insensitive' } },
          { taxId: { contains: query.search, mode: 'insensitive' } },
        ],
      }),
    };
    const [data, total] = await Promise.all([
      this.prisma.partner.findMany({ where, orderBy: { name: 'asc' }, ...paginate(query.page, query.limit) }),
      this.prisma.partner.count({ where }),
    ]);
    return { data, meta: buildMeta(total, query.page, query.limit) };
  }

  async findById(id: string) {
    const partner = await this.prisma.partner.findUnique({ where: { id } });
    if (!partner) throw new NotFoundException(NOT_FOUND);
    return partner;
  }

  async create(dto: CreatePartnerDto) {
    this.assertHasKind(dto.isCustomer, dto.isSupplier);
    return this.prisma.partner.create({ data: { ...dto, code: dto.code.toUpperCase(), tenantId: requireTenantId() } });
  }

  async update(id: string, dto: UpdatePartnerDto) {
    const partner = await this.findById(id);
    this.assertHasKind(dto.isCustomer ?? partner.isCustomer, dto.isSupplier ?? partner.isSupplier);
    return this.prisma.partner.update({ where: { id }, data: { ...dto, code: dto.code?.toUpperCase() } });
  }

  private assertHasKind(isCustomer?: boolean, isSupplier?: boolean) {
    if (!isCustomer && !isSupplier) {
      throw new UnprocessableEntityException({
        error: 'PARTNER_KIND_REQUIRED',
        message: 'Marca si es cliente, proveedor o ambos',
      });
    }
  }
}
