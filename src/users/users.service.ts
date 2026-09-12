import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcryptjs';
import { Prisma, Role } from '@prisma/client';

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

  findByUsername(username: string) {
    return this.prisma.user.findUnique({
      where: { username },
      include: { warehouse: true },
    });
  }

  findById(id: string) {
    return this.prisma.user.findUnique({ where: { id } });
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
  ) {
    const { password, warehouseId, ...rest } = data;
    const updateData: Prisma.UserUncheckedUpdateInput = { ...rest };
    if (password) updateData.password = await bcrypt.hash(password, 10);
    if (warehouseId !== undefined) (updateData as Record<string, unknown>).warehouseId = warehouseId ?? null;
    return this.prisma.user.update({
      where: { id },
      data: updateData,
      select: USER_SELECT,
    });
  }
}
