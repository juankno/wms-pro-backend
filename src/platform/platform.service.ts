import { ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma, Role, TenantStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { PlanLimitsService } from '../tenancy/plan-limits.service';
import { resolveLimits } from '../tenancy/plans';
import { runInTenant } from '../tenancy/tenant-context';
import { CreateTenantDto, ImpersonateDto, UpdateTenantDto } from './dto/platform.dto';
import { PLATFORM_SCOPE, PlatformPrincipal } from './platform-jwt.strategy';
import { AuditService } from '../audit/audit.service';
import { effectivePermissions } from '../auth/permissions';
import { buildMeta, paginate } from '../common/dto/pagination.dto';

// Compared when the admin does not exist so response time does not reveal valid emails.
const TIMING_EQUALIZER_HASH = '$2a$10$rCdXaZUkNywG76og.PGgPe1v/aviIqzEO1LrJ/2YZeerk3CrGqbpS';

// Support sessions get no refresh token, so access ends when this expires.
const SUPPORT_SESSION_TTL_SECONDS = 30 * 60;

@Injectable()
export class PlatformService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private planLimits: PlanLimitsService,
    private audit: AuditService,
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

  async createTenant(dto: CreateTenantDto, actor: PlatformPrincipal, ip?: string) {
    const password = await bcrypt.hash(dto.admin.password, 10);
    const result = await this.prisma.$transaction(async (tx) => {
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
    await this.record(actor, 'tenant.create', {
      tenantId: result.tenant.id,
      details: { slug: dto.slug, name: dto.name, plan: result.tenant.plan, adminUsername: dto.admin.username },
      ip,
    });
    return result;
  }

  async updateTenant(id: string, dto: UpdateTenantDto, actor: PlatformPrincipal, ip?: string) {
    const tenant = await this.findTenant(id);
    const settings = (tenant.settings ?? {}) as Prisma.JsonObject;
    const nextSettings = dto.limits
      ? { ...settings, limits: { ...((settings.limits as Prisma.JsonObject | undefined) ?? {}), ...dto.limits } }
      : settings;

    const updated = await this.prisma.tenant.update({
      where: { id },
      data: { name: dto.name, plan: dto.plan, status: dto.status, settings: nextSettings },
    });
    const details = { name: dto.name, plan: dto.plan, status: dto.status, limits: dto.limits && { ...dto.limits } };
    await this.record(actor, 'tenant.update', { tenantId: id, details, ip });
    return updated;
  }

  async impersonate(tenantId: string, dto: ImpersonateDto, actor: PlatformPrincipal, ip?: string) {
    const tenant = await this.findTenant(tenantId);
    if (tenant.status !== TenantStatus.active) {
      throw new ForbiddenException({ error: 'TENANT_SUSPENDED', message: 'La cuenta de la empresa está suspendida' });
    }
    const user = await this.prisma.user.findFirst({
      where: { tenantId, active: true, ...(dto.userId ? { id: dto.userId } : { role: Role.admin }) },
      orderBy: { createdAt: 'asc' },
      include: { warehouse: true, customRole: true },
    });
    if (!user) throw new NotFoundException({ error: 'USER_NOT_FOUND', message: 'Usuario no encontrado en la empresa' });

    const accessToken = this.jwt.sign(
      {
        sub: user.id,
        tenantId,
        username: user.username,
        role: user.role,
        warehouseId: user.warehouseId,
        impersonatorId: actor.id,
      },
      { expiresIn: SUPPORT_SESSION_TTL_SECONDS },
    );
    await Promise.all([
      this.record(actor, 'tenant.impersonate', {
        tenantId,
        details: { userId: user.id, username: user.username, reason: dto.reason },
        ip,
      }),
      this.audit.record({
        tenantId,
        actorId: user.id,
        actorName: user.name,
        action: 'impersonate',
        resource: 'support_session',
        resourceId: user.id,
        route: 'POST /platform/tenants/:id/impersonate',
        statusCode: 201,
        payload: { reason: dto.reason },
        ip,
        impersonatorId: actor.id,
        impersonatorName: actor.name,
      }),
    ]);

    return {
      accessToken,
      expiresIn: SUPPORT_SESSION_TTL_SECONDS,
      tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
      user: {
        id: user.id,
        name: user.name,
        role: user.role,
        warehouseId: user.warehouseId,
        warehouseName: user.warehouse?.name ?? '',
        permissions: effectivePermissions(user.role, user.customRole?.permissions),
      },
      impersonator: { id: actor.id, name: actor.name },
    };
  }

  async auditLog(opts: { tenantId?: string; page: number; limit: number }) {
    const where: Prisma.PlatformAuditLogWhereInput = { tenantId: opts.tenantId };
    const [data, total] = await Promise.all([
      this.prisma.platformAuditLog.findMany({ where, orderBy: { createdAt: 'desc' }, ...paginate(opts.page, opts.limit) }),
      this.prisma.platformAuditLog.count({ where }),
    ]);
    return { data, meta: buildMeta(total, opts.page, opts.limit) };
  }

  private record(
    actor: PlatformPrincipal,
    action: string,
    entry: { tenantId?: string; details?: Prisma.InputJsonObject; ip?: string },
  ) {
    return this.prisma.platformAuditLog.create({
      data: { adminId: actor.id, adminEmail: actor.email, action, ...entry },
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
