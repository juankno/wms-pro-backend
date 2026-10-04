import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { RejectImpersonationGuard } from './reject-impersonation.guard';

const contextFor = (user: object) =>
  ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as unknown as ExecutionContext;

describe('RejectImpersonationGuard', () => {
  const guard = new RejectImpersonationGuard();

  it('lets regular sessions through', () => {
    expect(guard.canActivate(contextFor({ id: 'u1' }))).toBe(true);
  });

  it('blocks support sessions', () => {
    expect(() => guard.canActivate(contextFor({ id: 'u1', impersonator: { id: 'p1', name: 'Ops' } }))).toThrow(
      ForbiddenException,
    );
  });
});
