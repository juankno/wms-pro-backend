import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { RequestWithUser } from '../common/types/request-with-user.interface';
import { runInTenant } from './tenant-context';

// Runs authenticated handlers inside the tenant of the JWT so every query is scoped.
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const tenantId = context.switchToHttp().getRequest<Partial<RequestWithUser>>().user?.tenantId;
    if (!tenantId) return next.handle();
    return new Observable((subscriber) => runInTenant(tenantId, () => next.handle().subscribe(subscriber)));
  }
}
