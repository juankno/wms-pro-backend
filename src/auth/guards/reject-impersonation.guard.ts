import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { RequestWithUser } from '../../common/types/request-with-user.interface';

// Support sessions act on behalf of a user but must not change that user's own credentials or sessions.
@Injectable()
export class RejectImpersonationGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { user } = context.switchToHttp().getRequest<RequestWithUser>();
    if (user.impersonator) {
      throw new ForbiddenException({
        error: 'IMPERSONATION_FORBIDDEN',
        message: 'Esta acción no está disponible en una sesión de soporte',
      });
    }
    return true;
  }
}
