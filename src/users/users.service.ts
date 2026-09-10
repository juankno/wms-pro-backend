import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { Role } from '@prisma/client';

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
    warehouseId: string;
  }) {
    const hashed = await bcrypt.hash(data.password, 10);
    return this.prisma.user.create({ data: { ...data, password: hashed } });
  }
}
