import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { authConfig } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';

export const PLATFORM_SCOPE = 'platform';

export interface PlatformPrincipal {
  id: string;
  email: string;
  name: string;
}

interface PlatformJwtPayload {
  sub: string;
  scope?: string;
}

@Injectable()
export class PlatformJwtStrategy extends PassportStrategy(Strategy, 'platform-jwt') {
  constructor(private prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: authConfig().accessSecret,
    });
  }

  async validate(payload: PlatformJwtPayload): Promise<PlatformPrincipal> {
    if (payload.scope !== PLATFORM_SCOPE) throw new UnauthorizedException({ error: 'AUTH_TOKEN_EXPIRED' });
    const admin = await this.prisma.platformAdmin.findUnique({ where: { id: payload.sub } });
    if (!admin?.active) throw new UnauthorizedException({ error: 'AUTH_TOKEN_EXPIRED' });
    return { id: admin.id, email: admin.email, name: admin.name };
  }
}
