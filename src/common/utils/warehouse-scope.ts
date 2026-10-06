import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AuthUser } from '../types/request-with-user.interface';

// Users with warehouses.all reach every warehouse; the rest only their assigned one (none if unassigned).
const canAccessAllWarehouses = (user: AuthUser) => user.permissions.includes('warehouses.all');

export function assertWarehouseAccess(user: AuthUser, warehouseId: string): void {
  if (canAccessAllWarehouses(user)) return;
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
  if (canAccessAllWarehouses(user)) return requested;
  return resolveWarehouseId(user, requested);
}

// Warehouse whose stock is shown next to catalog data; admins without one see the catalog only.
export function stockWarehouseFor(user: AuthUser, requested?: string): string | undefined {
  if (!requested) return user.warehouseId ?? undefined;
  assertWarehouseAccess(user, requested);
  return requested;
}
