import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ThrottlerException } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = request.headers['x-request-id'] as string | undefined;

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let error = 'INTERNAL_SERVER_ERROR';
    let message = 'Error interno del servidor';
    let details: unknown = undefined;

    if (exception instanceof ThrottlerException) {
      status = HttpStatus.TOO_MANY_REQUESTS;
      error = 'RATE_LIMIT_EXCEEDED';
      message = 'Demasiadas solicitudes. Intenta de nuevo más tarde.';
      response.setHeader('Retry-After', '60');
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();

      if (typeof res === 'object' && res !== null) {
        const r = res as Record<string, unknown>;

        // NestJS ValidationPipe emits { message: string[], error: 'Bad Request' }
        // Transform to our format: { error: 'VALIDATION_ERROR', details: [...] }
        if (
          status === HttpStatus.BAD_REQUEST &&
          Array.isArray(r['message']) &&
          (r['error'] === 'Bad Request' || !r['error'])
        ) {
          error = 'VALIDATION_ERROR';
          message = 'Datos de entrada inválidos';
          details = (r['message'] as string[]).map((msg) => {
            const match = msg.match(/^([^.]+)\s(.+)$/);
            return match
              ? { field: match[1], message: match[2] }
              : { field: 'unknown', message: msg };
          });
        } else {
          error = (r['error'] as string) ?? this.statusToCode(status);
          message = Array.isArray(r['message'])
            ? (r['message'] as string[]).join('; ')
            : ((r['message'] as string) ?? message);
          details = r['details'];
        }
      } else {
        message = String(res);
        error = this.statusToCode(status);
      }
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      const prismaError = this.handlePrismaError(exception);
      status = prismaError.status;
      error = prismaError.error;
      message = prismaError.message;
    } else if (exception instanceof Error) {
      this.logger.error(
        `[${requestId ?? 'no-id'}] ${request.method} ${request.url} — ${exception.message}`,
        exception.stack,
      );
    }

    const body: Record<string, unknown> = { error, message };
    if (details !== undefined) body['details'] = details;
    if (requestId) body['requestId'] = requestId;

    response.status(status).json(body);
  }

  private handlePrismaError(e: Prisma.PrismaClientKnownRequestError): {
    status: number;
    error: string;
    message: string;
  } {
    switch (e.code) {
      case 'P2002': {
        const field = Array.isArray(e.meta?.['target'])
          ? (e.meta['target'] as string[]).join(', ')
          : 'campo';
        return { status: 409, error: 'CONFLICT', message: `Ya existe un registro con el mismo ${field}` };
      }
      case 'P2025':
        return { status: 404, error: 'NOT_FOUND', message: 'Registro no encontrado' };
      case 'P2003':
        return { status: 409, error: 'CONFLICT', message: 'La operación viola una restricción de clave foránea' };
      case 'P2014':
        return { status: 409, error: 'CONFLICT', message: 'La relación requerida no existe' };
      default:
        this.logger.error(`Prisma error ${e.code}: ${e.message}`);
        return { status: 500, error: 'INTERNAL_SERVER_ERROR', message: 'Error de base de datos' };
    }
  }

  private statusToCode(status: number): string {
    const map: Record<number, string> = {
      400: 'VALIDATION_ERROR',
      401: 'AUTH_TOKEN_EXPIRED',
      403: 'AUTH_UNAUTHORIZED',
      404: 'NOT_FOUND',
      409: 'CONFLICT',
      422: 'UNPROCESSABLE_ENTITY',
      429: 'RATE_LIMIT_EXCEEDED',
      500: 'INTERNAL_SERVER_ERROR',
    };
    return map[status] ?? 'UNKNOWN_ERROR';
  }
}
