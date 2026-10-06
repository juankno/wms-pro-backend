import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { PlanLimitsService } from '../tenancy/plan-limits.service';
import { resolveLimits } from '../tenancy/plans';
import { runInTenant } from '../tenancy/tenant-context';
import { CreateTenantDto, UpdateTenantDto } from './dto/platform.dto';
import { PLATFORM_SCOPE } from './platform-jwt.strategy';

// Compared when the admin does not exist so response time does not reveal valid emails.
const TIMING_EQUALIZER_HASH = '$2a$10$rCdXaZUkNywG76og.PGgPe1v/aviIqzEO1LrJ/2YZeerk3CrGqbpS';

@Injectable()
export class PlatformService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private planLimits: PlanLimitsService,
  ) {}

  async login(email: string, password: string) {
    const admin = await this.prisma.platformAdmin.findUnique({ where: { email: email.toLowerCase() } });
    const matches = await bcrypt.compare(password, admin?.password ?? TIMING_EQUALIZER_HASH);
    if (!admin?.active || !matches) {
      throw new UnauthorizedException({ error: 'AUTH_INVALID_CREDENTIALS', message: 'Credenciales incorrectas' });
    }
    return {
      accessToken: this.jwt.sign({ sub: admin.id, scope: PLATFORM_SCOPE }),
      admin: { id: admin.id, email: admin.email, name: admin.name },
    };
  }

  async listTenants() {
    const tenants = await this.prisma.tenant.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { users: true, warehouses: true, products: true } } },
    });
    return tenants.map(({ _count, settings, ...tenant }) => ({
      ...tenant,
      limits: resolveLimits(tenant.plan, settings),
      counts: _count,
    }));
  }

  async createTenant(dto: CreateTenantDto) {
    const password = await bcrypt.hash(dto.admin.password, 10);
    return this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({ data: { slug: dto.slug, name: dto.name, plan: dto.plan } });
      const admin = await tx.user.create({
        data: {
          tenantId: tenant.id,
          username: dto.admin.username,
          name: dto.admin.name,
          email: dto.admin.email,
          password,
          role: Role.admin,
        },
        select: { id: true, username: true, name: true, email: true, role: true },
      });
      return { tenant, admin };
    });
  }

  async updateTenant(id: string, dto: UpdateTenantDto) {
    const tenant = await this.findTenant(id);
    const settings = (tenant.settings ?? {}) as Prisma.JsonObject;
    const nextSettings = dto.limits
      ? { ...settings, limits: { ...((settings.limits as Prisma.JsonObject | undefined) ?? {}), ...dto.limits } }
      : settings;

    return this.prisma.tenant.update({
      where: { id },
      data: { name: dto.name, plan: dto.plan, status: dto.status, settings: nextSettings },
    });
  }

  async tenantUsage(id: string) {
    await this.findTenant(id);
    return runInTenant(id, () => this.planLimits.usage());
  }

  private async findTenant(id: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id } });
    if (!tenant) throw new NotFoundException({ error: 'TENANT_NOT_FOUND', message: 'Empresa no encontrada' });
    return tenant;
  }
}
