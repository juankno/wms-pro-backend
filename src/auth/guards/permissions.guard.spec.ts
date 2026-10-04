import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { Permission } from '../permissions';
import { PermissionsGuard } from './permissions.guard';

const contextFor = (permissions: Permission[]) =>
  ({
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ user: { permissions } }) }),
  }) as unknown as ExecutionContext;

const guardRequiring = (required?: Permission[]) =>
  new PermissionsGuard({ getAllAndOverride: () => required } as unknown as Reflector);

describe('PermissionsGuard', () => {
  it('allows routes without required permissions', () => {
    expect(guardRequiring(undefined).canActivate(contextFor([]))).toBe(true);
  });

  it('allows users holding every required permission', () => {
    expect(guardRequiring(['stock.adjust']).canActivate(contextFor(['stock.adjust', 'reports.read']))).toBe(true);
  });

  it('rejects users missing a permission and reports which one', () => {
    expect(() => guardRequiring(['stock.adjust', 'stock.transfer']).canActivate(contextFor(['stock.adjust']))).toThrow(
      ForbiddenException,
    );
    try {
      guardRequiring(['stock.transfer']).canActivate(contextFor([]));
    } catch (error) {
      expect((error as ForbiddenException).getResponse()).toMatchObject({ details: { missing: ['stock.transfer'] } });
    }
  });
});
