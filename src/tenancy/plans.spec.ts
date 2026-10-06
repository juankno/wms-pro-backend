import { describe, expect, it } from 'vitest';
import { PLAN_LIMITS, resolveLimits } from './plans';

describe('resolveLimits', () => {
  it('uses the plan defaults', () => {
    expect(resolveLimits('pro', {})).toEqual(PLAN_LIMITS.pro);
  });

  it('falls back to trial for unknown plans', () => {
    expect(resolveLimits('legacy', null)).toEqual(PLAN_LIMITS.trial);
  });

  it('applies valid per-tenant overrides, including unlimited', () => {
    expect(resolveLimits('starter', { limits: { users: 25, ordersPerMonth: null } })).toEqual({
      users: 25,
      warehouses: PLAN_LIMITS.starter.warehouses,
      ordersPerMonth: null,
    });
  });

  it('ignores invalid overrides', () => {
    expect(resolveLimits('starter', { limits: { users: -1, warehouses: '3', ordersPerMonth: 1.5 } })).toEqual(
      PLAN_LIMITS.starter,
    );
  });
});
