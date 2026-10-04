import { Role } from '@prisma/client';

// Catalog of grantable permissions; labels are shown in the role editor.
export const PERMISSIONS = {
  'products.write': 'Crear y editar productos y sus fotos',
  'products.delete': 'Desactivar productos',
  'stock.adjust': 'Registrar ajustes y entradas de stock',
  'stock.settings': 'Editar ubicación y stock mínimo',
  'stock.transfer': 'Trasladar stock entre almacenes',
  'orders.delete': 'Eliminar órdenes pendientes',
  'reports.read': 'Ver reportes y dashboard',
  'users.read': 'Ver usuarios',
  'users.manage': 'Crear y editar usuarios',
  'roles.manage': 'Administrar roles y permisos',
  'warehouses.manage': 'Crear y editar almacenes',
  'locations.manage': 'Crear y editar ubicaciones de los almacenes',
  'partners.manage': 'Crear y editar clientes y proveedores',
  'warehouses.all': 'Operar en todos los almacenes',
  'audit.read': 'Ver auditoría',
  'tenant.manage': 'Ver plan y uso de la empresa',
} as const;

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export const DEFAULT_ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  operator: [],
  supervisor: [
    'products.write',
    'stock.adjust',
    'stock.settings',
    'stock.transfer',
    'locations.manage',
    'partners.manage',
    'orders.delete',
    'reports.read',
    'users.read',
  ],
  admin: ALL_PERMISSIONS,
};

export function isPermission(value: string): value is Permission {
  return value in PERMISSIONS;
}

// Admins always keep every permission so a tenant cannot lock itself out.
export function effectivePermissions(role: Role, customRolePermissions?: string[] | null): Permission[] {
  if (role === Role.admin || !customRolePermissions) return DEFAULT_ROLE_PERMISSIONS[role];
  return customRolePermissions.filter(isPermission);
}
