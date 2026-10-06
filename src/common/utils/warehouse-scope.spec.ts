import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { AuthUser } from '../types/request-with-user.interface';
import { assertWarehouseAccess, resolveWarehouseId, scopeWarehouseFilter } from './warehouse-scope';
import { effectivePermissions } from '../../auth/permissions';

const buildUser = (role: Role, warehouseId: string | null): AuthUser => ({
  id: 'u1', sub: 'u1', tenantId: 't1', name: 'User', username: 'user', role, warehouseId, permissions: effectivePermissions(role),
});

describe('warehouse scope', () => {
  describe('assertWarehouseAccess', () => {
    it('lets admins access any warehouse', () => {
      expect(() => assertWarehouseAccess(buildUser(Role.admin, null), 'w2')).not.toThrow();
    });

    it('lets non-admins access their own warehouse', () => {
      expect(() => assertWarehouseAccess(buildUser(Role.operator, 'w1'), 'w1')).not.toThrow();
    });

    it('forbids non-admins from other warehouses', () => {
      expect(() => assertWarehouseAccess(buildUser(Role.supervisor, 'w1'), 'w2')).toThrow(ForbiddenException);
    });

    it('forbids non-admins without an assigned warehouse', () => {
      expect(() => assertWarehouseAccess(buildUser(Role.supervisor, null), 'w1')).toThrow(ForbiddenException);
    });
  });

  describe('resolveWarehouseId', () => {
    it("falls back to the user's warehouse", () => {
      expect(resolveWarehouseId(buildUser(Role.operator, 'w1'))).toBe('w1');
    });

    it('requires a warehouse when none can be resolved', () => {
      expect(() => resolveWarehouseId(buildUser(Role.admin, null))).toThrow(BadRequestException);
    });
  });

  describe('scopeWarehouseFilter', () => {
    it('lets admins list every warehouse', () => {
      expect(scopeWarehouseFilter(buildUser(Role.admin, 'w1'))).toBeUndefined();
    });

    it("restricts non-admins to their warehouse", () => {
      expect(scopeWarehouseFilter(buildUser(Role.operator, 'w1'))).toBe('w1');
      expect(() => scopeWarehouseFilter(buildUser(Role.operator, 'w1'), 'w2')).toThrow(ForbiddenException);
    });
  });
});
