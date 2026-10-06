import { Request } from 'express';
import { Role } from '@prisma/client';
import type { Permission } from '../../auth/permissions';

export interface JwtPayload {
  sub: string;
  tenantId: string;
  username: string;
  role: Role;
  warehouseId: string | null;
}

export interface AuthUser extends JwtPayload {
  id: string;
  name: string;
  permissions: Permission[];
}

export interface RequestWithUser extends Request {
  user: AuthUser;
}
