import { BadRequestException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Role, Tenant, TenantStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { createHmac, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { authConfig } from '../config/env';
import { LoginDto } from './dto/login.dto';

// Compared when the user does not exist so response time does not reveal valid usernames.
const TIMING_EQUALIZER_HASH = '$2a$10$rCdXaZUkNywG76og.PGgPe1v/aviIqzEO1LrJ/2YZeerk3CrGqbpS';

const INVALID_CREDENTIALS = { error: 'AUTH_INVALID_CREDENTIALS', message: 'Usuario o contraseña incorrectos' };
const REFRESH_EXPIRED = { error: 'AUTH_REFRESH_EXPIRED', message: 'Sesión expirada. Inicia sesión nuevamente.' };
const REFRESH_REUSED = { error: 'AUTH_REFRESH_REUSED', message: 'Sesión invalidada por seguridad. Inicia sesión nuevamente.' };

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private usersService: UsersService,
    private jwtService: JwtService,
  ) {}

  async login(dto: LoginDto) {
    const tenant = await this.resolveLoginTenant(dto.tenant);
    const user = tenant ? await this.usersService.findByUsername(tenant.id, dto.username) : null;
    const passwordMatches = await bcrypt.compare(dto.password, user?.password ?? TIMING_EQUALIZER_HASH);
    if (!tenant || !user || !user.active || !passwordMatches) throw new UnauthorizedException(INVALID_CREDENTIALS);
    this.assertTenantActive(tenant);

    const tokens = await this.issueTokens(user);
    return {
      ...tokens,
      tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
      user: {
        id: user.id,
        name: user.name,
        role: user.role,
        warehouseId: user.warehouseId,
        warehouseName: user.warehouse?.name ?? '',
      },
    };
  }

  async refresh(refreshToken: string) {
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.hashRefreshToken(refreshToken) },
      include: { user: { include: { tenant: true } } },
    });
    if (!stored) throw new UnauthorizedException(REFRESH_EXPIRED);

    if (stored.revoked) {
      await this.revokeAllSessions(stored.userId);
      throw new UnauthorizedException(REFRESH_REUSED);
    }
    if (stored.expiresAt < new Date() || !stored.user.active) {
      throw new UnauthorizedException(REFRESH_EXPIRED);
    }
    this.assertTenantActive(stored.user.tenant);

    const { count } = await this.prisma.refreshToken.updateMany({
      where: { id: stored.id, revoked: false },
      data: { revoked: true },
    });
    if (count === 0) {
      await this.revokeAllSessions(stored.userId);
      throw new UnauthorizedException(REFRESH_REUSED);
    }

    return this.issueTokens(stored.user);
  }

  async logout(userId: string) {
    await this.revokeAllSessions(userId);
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        name: true,
        email: true,
        role: true,
        warehouseId: true,
        warehouse: { select: { name: true } },
      },
    });
    if (!user) throw new NotFoundException({ error: 'USER_NOT_FOUND', message: 'Usuario no encontrado' });
    const { warehouse, ...profile } = user;
    return { ...profile, warehouseName: warehouse?.name ?? '' };
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !(await bcrypt.compare(currentPassword, user.password))) {
      throw new UnauthorizedException({ error: 'AUTH_INVALID_PASSWORD', message: 'La contraseña actual no es correcta' });
    }

    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { password: await bcrypt.hash(newPassword, 10) } }),
      this.prisma.refreshToken.updateMany({ where: { userId, revoked: false }, data: { revoked: true } }),
    ]);
  }

  async updatePushToken(userId: string, pushToken: string) {
    await this.prisma.user.update({ where: { id: userId }, data: { pushToken } });
  }

  revokeAllSessions(userId: string) {
    return this.prisma.refreshToken.updateMany({ where: { userId, revoked: false }, data: { revoked: true } });
  }

  // Without a slug the only active company is used, so single-tenant clients keep working.
  private async resolveLoginTenant(slug?: string): Promise<Tenant | null> {
    if (slug) return this.prisma.tenant.findUnique({ where: { slug } });

    const active = await this.prisma.tenant.findMany({ where: { status: TenantStatus.active }, take: 2 });
    if (active.length === 1) return active[0];
    throw new BadRequestException({ error: 'TENANT_REQUIRED', message: 'Indica el código de tu empresa' });
  }

  private assertTenantActive(tenant: Tenant) {
    if (tenant.status !== TenantStatus.active) {
      throw new ForbiddenException({ error: 'TENANT_SUSPENDED', message: 'La cuenta de la empresa está suspendida' });
    }
  }

  private async issueTokens(user: { id: string; tenantId: string; username: string; role: Role; warehouseId: string | null }) {
    const { accessTtlSeconds, refreshTtlSeconds } = authConfig();
    const accessToken = this.jwtService.sign({
      sub: user.id,
      tenantId: user.tenantId,
      username: user.username,
      role: user.role,
      warehouseId: user.warehouseId,
    });

    const refreshToken = randomBytes(32).toString('base64url');
    await this.prisma.refreshToken.create({
      data: {
        tokenHash: this.hashRefreshToken(refreshToken),
        userId: user.id,
        expiresAt: new Date(Date.now() + refreshTtlSeconds * 1000),
      },
    });

    return { accessToken, refreshToken, expiresIn: accessTtlSeconds };
  }

  private hashRefreshToken(token: string) {
    return createHmac('sha256', authConfig().refreshSecret).update(token).digest('hex');
  }
}
