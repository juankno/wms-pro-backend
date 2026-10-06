import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DEFAULT_ROLE_PERMISSIONS, Permission, PERMISSIONS } from '../auth/permissions';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenancy/tenant-context';

@Injectable()
export class RolesService {
  constructor(private prisma: PrismaService) {}

  catalog() {
    return {
      permissions: Object.entries(PERMISSIONS).map(([key, label]) => ({ key, label })),
      baseRoles: DEFAULT_ROLE_PERMISSIONS,
    };
  }

  findAll() {
    return this.prisma.tenantRole.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { users: true } } },
    });
  }

  create(data: { name: string; description?: string; permissions: Permission[] }) {
    return this.prisma.tenantRole.create({ data: { ...data, tenantId: requireTenantId() } });
  }

  async update(id: string, data: Partial<{ name: string; description: string; permissions: Permission[] }>) {
    await this.findById(id);
    return this.prisma.tenantRole.update({ where: { id }, data });
  }

  async delete(id: string) {
    const role = await this.prisma.tenantRole.findUnique({
      where: { id },
      include: { _count: { select: { users: true } } },
    });
    if (!role) throw this.notFound();
    if (role._count.users > 0) {
      throw new ConflictException({
        error: 'ROLE_IN_USE',
        message: `El rol está asignado a ${role._count.users} usuario(s). Reasígnalos antes de eliminarlo.`,
      });
    }
    return this.prisma.tenantRole.delete({ where: { id } });
  }

  async findById(id: string) {
    const role = await this.prisma.tenantRole.findUnique({ where: { id } });
    if (!role) throw this.notFound();
    return role;
  }

  private notFound() {
    return new NotFoundException({ error: 'ROLE_NOT_FOUND', message: 'Rol no encontrado' });
  }
}
