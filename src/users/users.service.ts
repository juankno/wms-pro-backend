import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcryptjs';
import { Prisma, Role } from '@prisma/client';
import { AuthUser } from '../common/types/request-with-user.interface';
import { requireTenantId } from '../tenancy/tenant-context';

const USER_SELECT = {
  id: true,
  username: true,
  name: true,
  email: true,
  role: true,
  warehouseId: true,
  active: true,
  createdAt: true,
  updatedAt: true,
  warehouse: { select: { id: true, name: true, code: true } },
} as const;

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  findByUsername(tenantId: string, username: string) {
    return this.prisma.user.findUnique({
      where: { tenantId_username: { tenantId, username } },
      include: { warehouse: true },
    });
  }

  findById(id: string) {
    return this.prisma.user.findUnique({ where: { id }, include: { tenant: true } });
  }

  findAll() {
    return this.prisma.user.findMany({
      select: USER_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  findByWarehouse(warehouseId: string) {
    return this.prisma.user.findMany({
      where: { warehouseId, active: true },
      select: { id: true, username: true, name: true, role: true },
    });
  }

  async create(data: {
    username: string;
    name: string;
    email: string;
    password: string;
    role: Role;
    warehouseId?: string | null;
  }) {
    const hashed = await bcrypt.hash(data.password, 10);
    const { warehouseId, ...rest } = data;
    const createData: Prisma.UserUncheckedCreateInput = {
      ...rest,
      tenantId: requireTenantId(),
      password: hashed,
      ...(warehouseId ? { warehouseId } : {}),
    };
    return this.prisma.user.create({ data: createData, select: USER_SELECT });
  }

  async update(
    id: string,
    data: {
      name?: string;
      email?: string;
      password?: string;
      role?: Role;
      warehouseId?: string | null;
      active?: boolean;
    },
    actor: AuthUser,
  ) {
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target) throw new NotFoundException({ error: 'USER_NOT_FOUND', message: 'Usuario no encontrado' });

    const deactivates = data.active === false;
    const demotesAdmin = target.role === Role.admin && data.role !== undefined && data.role !== Role.admin;
    if (id === actor.id && (deactivates || demotesAdmin)) {
      throw new UnprocessableEntityException({
        error: 'CANNOT_MODIFY_SELF',
        message: 'No puedes desactivarte ni quitarte el rol de administrador',
      });
    }

    const { password, warehouseId, ...rest } = data;
    const updateData: Prisma.UserUncheckedUpdateInput = { ...rest };
    if (password) updateData.password = await bcrypt.hash(password, 10);
    if (warehouseId !== undefined) updateData.warehouseId = warehouseId;

    return this.prisma.$transaction(async (tx) => {
      if (target.role === Role.admin && target.active && (deactivates || demotesAdmin)) {
        await tx.$queryRaw`SELECT id FROM users WHERE "tenantId" = ${requireTenantId()} AND role = 'admin' AND active = true FOR UPDATE`;
        const otherAdmins = await tx.user.count({ where: { role: Role.admin, active: true, id: { not: id } } });
        if (otherAdmins === 0) {
          throw new UnprocessableEntityException({
            error: 'LAST_ADMIN',
            message: 'Debe quedar al menos un administrador activo',
          });
        }
      }

      if (password || deactivates) {
        await tx.refreshToken.updateMany({ where: { userId: id, revoked: false }, data: { revoked: true } });
      }

      return tx.user.update({ where: { id }, data: updateData, select: USER_SELECT });
    });
  }
}
