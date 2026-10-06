import { describe, expect, it } from 'vitest';
import { auditAction, auditPayload, auditResource, REDACTED } from './audit-payload';

describe('audit payload', () => {
  it('redacts secrets at any depth', () => {
    expect(
      auditPayload({ username: 'ana', password: 'x', nested: { refreshToken: 'y', items: [{ apiSecret: 'z', qty: 1 }] } }),
    ).toEqual({ username: 'ana', password: REDACTED, nested: { refreshToken: REDACTED, items: [{ apiSecret: REDACTED, qty: 1 }] } });
  });

  it('skips empty bodies and truncates very large ones', () => {
    expect(auditPayload({})).toBeUndefined();
    expect(auditPayload(undefined)).toBeUndefined();
    expect(auditPayload({ notes: 'a'.repeat(20_000) })).toMatchObject({ truncated: true });
  });

  it.each([
    ['POST', 'create'],
    ['PATCH', 'update'],
    ['PUT', 'update'],
    ['DELETE', 'delete'],
    ['GET', undefined],
  ])('maps %s to %s', (method, action) => {
    expect(auditAction(method)).toBe(action);
  });

  it.each([
    ['/v1/products/:id/photos', 'products'],
    ['/picking/:id/items/:itemId', 'picking'],
    ['/v1/stock/transfer', 'stock'],
  ])('derives the resource of %s', (route, resource) => {
    expect(auditResource(route)).toBe(resource);
  });
});
