import { Request } from 'express';
import { Role } from '@prisma/client';
import type { Permission } from '../../auth/permissions';

export interface JwtPayload {
  sub: string;
  tenantId: string;
  username: string;
  role: Role;
  warehouseId: string | null;
  // Platform admin behind a support session.
  impersonatorId?: string;
}

export interface AuthUser extends JwtPayload {
  id: string;
  name: string;
  permissions: Permission[];
  impersonator?: { id: string; name: string };
}

export interface RequestWithUser extends Request {
  user: AuthUser;
}
