import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AuthUser } from '../types/request-with-user.interface';

// Admins reach every warehouse; other roles only their assigned one (none if unassigned).
export function assertWarehouseAccess(user: AuthUser, warehouseId: string): void {
  if (user.role === Role.admin) return;
  if (!user.warehouseId || user.warehouseId !== warehouseId) {
    throw new ForbiddenException({
      error: 'WAREHOUSE_FORBIDDEN',
      message: 'No tienes acceso a este almacén',
    });
  }
}

export function resolveWarehouseId(user: AuthUser, requested?: string): string {
  const warehouseId = requested ?? user.warehouseId;
  if (!warehouseId) {
    throw new BadRequestException({
      error: 'WAREHOUSE_REQUIRED',
      message: 'Debes indicar el almacén',
    });
  }
  assertWarehouseAccess(user, warehouseId);
  return warehouseId;
}

export function scopeWarehouseFilter(user: AuthUser, requested?: string): string | undefined {
  if (user.role === Role.admin) return requested;
  return resolveWarehouseId(user, requested);
}
