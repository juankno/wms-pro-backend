import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private usersService: UsersService,
    private jwtService: JwtService,
  ) {}

  async login(dto: LoginDto) {
    const user = await this.usersService.findByUsername(dto.username);
    if (!user || !user.active) {
      throw new UnauthorizedException({
        error: 'AUTH_INVALID_CREDENTIALS',
        message: 'Usuario o contraseña incorrectos',
      });
    }

    const valid = await bcrypt.compare(dto.password, user.password);
    if (!valid) {
      throw new UnauthorizedException({
        error: 'AUTH_INVALID_CREDENTIALS',
        message: 'Usuario o contraseña incorrectos',
      });
    }

    const tokens = await this.generateTokens(user.id, user.username, user.role, user.warehouseId);

    return {
      ...tokens,
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
      where: { token: refreshToken },
      include: { user: true },
    });

    if (!stored || stored.revoked || stored.expiresAt < new Date()) {
      throw new UnauthorizedException({
        error: 'AUTH_REFRESH_EXPIRED',
        message: 'Sesión expirada. Inicia sesión nuevamente.',
      });
    }

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revoked: true },
    });

    return this.generateTokens(
      stored.user.id,
      stored.user.username,
      stored.user.role,
      stored.user.warehouseId,
    );
  }

  async logout(userId: string) {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revoked: false },
      data: { revoked: true },
    });
  }

  async updatePushToken(userId: string, pushToken: string) {
    await this.prisma.user.update({ where: { id: userId }, data: { pushToken } });
  }

  private async generateTokens(
    userId: string,
    username: string,
    role: string,
    warehouseId: string,
  ) {
    const payload = { sub: userId, username, role, warehouseId };
    const accessToken = this.jwtService.sign(payload);

    const refreshToken = uuidv4();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    await this.prisma.refreshToken.create({
      data: { token: refreshToken, userId, expiresAt },
    });

    return { accessToken, refreshToken, expiresIn: 3600 };
  }
}
