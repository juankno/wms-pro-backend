import { Role } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, effectivePermissions } from './permissions';

describe('effectivePermissions', () => {
  it('uses the defaults of the base role without a custom role', () => {
    expect(effectivePermissions(Role.supervisor)).toEqual(DEFAULT_ROLE_PERMISSIONS.supervisor);
    expect(effectivePermissions(Role.operator)).toEqual(['receiving.execute']);
  });

  it('replaces the base permissions with the custom role ones', () => {
    expect(effectivePermissions(Role.operator, ['stock.adjust', 'reports.read'])).toEqual(['stock.adjust', 'reports.read']);
  });

  it('drops unknown permissions stored in a custom role', () => {
    expect(effectivePermissions(Role.operator, ['stock.adjust', 'legacy.permission'])).toEqual(['stock.adjust']);
  });

  it('always grants every permission to admins', () => {
    expect(effectivePermissions(Role.admin, [])).toEqual(ALL_PERMISSIONS);
  });

  it('keeps the previous role behavior for base roles', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.supervisor).not.toContain('users.manage');
    expect(DEFAULT_ROLE_PERMISSIONS.supervisor).not.toContain('warehouses.all');
  });
});
