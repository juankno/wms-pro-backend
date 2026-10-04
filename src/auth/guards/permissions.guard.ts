import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequestWithUser } from '../../common/types/request-with-user.interface';
import { Permission } from '../permissions';
import { PERMISSIONS_KEY } from '../permissions.decorator';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;

    const { user } = context.switchToHttp().getRequest<RequestWithUser>();
    const missing = required.filter((permission) => !user.permissions.includes(permission));
    if (missing.length) {
      throw new ForbiddenException({
        error: 'PERMISSION_DENIED',
        message: 'No tienes permiso para realizar esta acción',
        details: { missing },
      });
    }
    return true;
  }
}
