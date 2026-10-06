import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { TenantStatus } from '@prisma/client';
import { JwtPayload, AuthUser } from '../../common/types/request-with-user.interface';
import { UsersService } from '../../users/users.service';
import { authConfig } from '../../config/env';
import { effectivePermissions } from '../permissions';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private usersService: UsersService,
    private prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: authConfig().accessSecret,
    });
  }

  async validate(payload: JwtPayload): Promise<AuthUser> {
    if (!payload.tenantId) throw new UnauthorizedException({ error: 'AUTH_TOKEN_EXPIRED' });
    const user = await this.usersService.findById(payload.sub);
    const valid = user?.active && user.tenantId === payload.tenantId && user.tenant.status === TenantStatus.active;
    if (!user || !valid) throw new UnauthorizedException({ error: 'AUTH_TOKEN_EXPIRED' });
    const impersonator = payload.impersonatorId ? await this.activeImpersonator(payload.impersonatorId) : undefined;
    return {
      id: user.id,
      sub: user.id,
      tenantId: user.tenantId,
      permissions: effectivePermissions(user.role, user.customRole?.permissions),
      username: user.username,
      name: user.name,
      role: user.role,
      warehouseId: user.warehouseId,
      ...(impersonator && { impersonator }),
    };
  }

  // Deactivating a platform admin ends their support sessions immediately.
  private async activeImpersonator(adminId: string) {
    const admin = await this.prisma.platformAdmin.findUnique({ where: { id: adminId } });
    if (!admin?.active) throw new UnauthorizedException({ error: 'AUTH_TOKEN_EXPIRED' });
    return { id: admin.id, name: admin.name };
  }
}
