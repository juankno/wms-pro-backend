import { ArgumentsHost, BadRequestException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { HttpExceptionFilter } from './http-exception.filter';

const run = (exception: unknown) => {
  let status = 0;
  let body: Record<string, unknown> = {};
  const response = {
    status: (code: number) => {
      status = code;
      return { json: (payload: Record<string, unknown>) => (body = payload) };
    },
    setHeader: vi.fn(),
  };
  const request = { headers: { 'x-request-id': 'req-1' }, method: 'POST', url: '/v1/test' };
  const host = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
  } as unknown as ArgumentsHost;

  new HttpExceptionFilter().catch(exception, host);
  return { status, body };
};

describe('HttpExceptionFilter', () => {
  it('maps ValidationPipe messages to field/message pairs', () => {
    const { status, body } = run(
      new BadRequestException(['quantity must be a positive number', 'items.0.productId should not be empty']),
    );

    expect(status).toBe(400);
    expect(body).toMatchObject({
      error: 'VALIDATION_ERROR',
      details: [
        { field: 'quantity', message: 'must be a positive number' },
        { field: 'items.0.productId', message: 'should not be empty' },
      ],
      requestId: 'req-1',
    });
  });

  it('keeps custom error codes from domain exceptions', () => {
    const { status, body } = run(
      new ForbiddenException({ error: 'WAREHOUSE_FORBIDDEN', message: 'No tienes acceso a este almacén' }),
    );

    expect(status).toBe(403);
    expect(body).toMatchObject({ error: 'WAREHOUSE_FORBIDDEN', message: 'No tienes acceso a este almacén' });
  });
});
