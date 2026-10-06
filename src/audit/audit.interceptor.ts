import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Response } from 'express';
import { Observable, tap } from 'rxjs';
import { RequestWithUser } from '../common/types/request-with-user.interface';
import { auditAction, auditPayload, auditResource } from './audit-payload';
import { AuditService } from './audit.service';

// Records every successful authenticated mutation. Failures to write the trail never fail the request.
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(private audit: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Partial<RequestWithUser>>();
    const action = auditAction(request.method ?? '');
    const user = request.user;
    if (!action || !user) return next.handle();

    return next.handle().pipe(
      tap((result: unknown) => {
        const routePath = (request.route as { path?: string } | undefined)?.path ?? request.path ?? '';
        const params = (request.params ?? {}) as Record<string, string>;
        const createdId = (result as { id?: unknown } | null)?.id;
        this.audit
          .record({
            tenantId: user.tenantId,
            actorId: user.id,
            actorName: user.name,
            action,
            resource: auditResource(routePath),
            resourceId: params.id ?? (typeof createdId === 'string' ? createdId : undefined),
            route: `${request.method} ${routePath}`,
            statusCode: http.getResponse<Response>().statusCode,
            payload: auditPayload(request.body),
            requestId: request.headers?.['x-request-id'] as string | undefined,
            ip: request.ip,
          })
          .catch((error: unknown) => this.logger.error(`Audit write failed: ${String(error)}`));
      }),
    );
  }
}
