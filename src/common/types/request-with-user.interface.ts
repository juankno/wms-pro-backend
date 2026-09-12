import { Request } from 'express';
import { Role } from '@prisma/client';

export interface JwtPayload {
  sub: string;
  username: string;
  role: Role;
  warehouseId: string | null;
}

export interface AuthUser extends JwtPayload {
  id: string;
  name: string;
}

export interface RequestWithUser extends Request {
  user: AuthUser;
}
