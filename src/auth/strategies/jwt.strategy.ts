import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { TenantStatus } from '@prisma/client';
import { JwtPayload, AuthUser } from '../../common/types/request-with-user.interface';
import { UsersService } from '../../users/users.service';
import { authConfig } from '../../config/env';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private usersService: UsersService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: authConfig().accessSecret,
    });
  }

  async validate(payload: JwtPayload): Promise<AuthUser> {
    const user = await this.usersService.findById(payload.sub);
    const valid = user?.active && user.tenantId === payload.tenantId && user.tenant.status === TenantStatus.active;
    if (!user || !valid) throw new UnauthorizedException({ error: 'AUTH_TOKEN_EXPIRED' });
    return {
      id: user.id,
      sub: user.id,
      tenantId: user.tenantId,
      username: user.username,
      name: user.name,
      role: user.role,
      warehouseId: user.warehouseId,
    };
  }
}
