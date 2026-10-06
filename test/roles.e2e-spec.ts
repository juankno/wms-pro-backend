import { ConflictException, NotFoundException } from '@nestjs/common';
import { Role, Tenant } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { effectivePermissions } from '../src/auth/permissions';
import { JwtStrategy } from '../src/auth/strategies/jwt.strategy';
import { AuthUser } from '../src/common/types/request-with-user.interface';
import { RolesService } from '../src/roles/roles.service';
import { PlanLimitsService } from '../src/tenancy/plan-limits.service';
import { UsersService } from '../src/users/users.service';
import { createTestTenant, deleteTestTenant, scopedTo, testPrisma } from './support/tenancy';

describe('Custom roles (integration)', () => {
  const prisma = testPrisma();
  let tenant: Tenant;
  let other: Tenant;
  let admin: AuthUser;
  let operatorId: string;
  const roles = scopedTo(new RolesService(prisma), () => tenant.id);
  const otherRoles = scopedTo(new RolesService(prisma), () => other.id);
  const users = scopedTo(new UsersService(prisma, new PlanLimitsService(prisma)), () => tenant.id);
  const strategy = new JwtStrategy(new UsersService(prisma, new PlanLimitsService(prisma)));

  beforeAll(async () => {
    [tenant, other] = await Promise.all([createTestTenant(prisma), createTestTenant(prisma)]);
    const [adminRow, operatorRow] = await Promise.all(
      [Role.admin, Role.operator].map((role) =>
        prisma.user.create({
          data: { tenantId: tenant.id, username: role, email: `${role}@roles.test`, name: role, password: 'unused', role },
        }),
      ),
    );
    admin = {
      id: adminRow.id, sub: adminRow.id, tenantId: tenant.id, username: 'admin', name: 'admin',
      role: Role.admin, warehouseId: null, permissions: effectivePermissions(Role.admin),
    };
    operatorId = operatorRow.id;
  });

  afterAll(async () => {
    await deleteTestTenant(prisma, tenant.id);
    await deleteTestTenant(prisma, other.id);
    await prisma.$disconnect();
  });

  const permissionsOf = async (userId: string) =>
    (await strategy.validate({ sub: userId, tenantId: tenant.id, username: '', role: Role.operator, warehouseId: null })).permissions;

  it('grants the permissions of an assigned custom role and reverts on removal', async () => {
    const role = await roles.create({ name: 'Jefe de inventario', permissions: ['stock.adjust', 'reports.read'] });

    await users.update(operatorId, { customRoleId: role.id }, admin);
    expect(await permissionsOf(operatorId)).toEqual(['stock.adjust', 'reports.read']);

    await users.update(operatorId, { customRoleId: null }, admin);
    expect(await permissionsOf(operatorId)).toEqual([]);
  });

  it('refuses to delete a role that is assigned', async () => {
    const role = await roles.create({ name: 'Auditor', permissions: ['audit.read'] });
    await users.update(operatorId, { customRoleId: role.id }, admin);

    await expect(roles.delete(role.id)).rejects.toBeInstanceOf(ConflictException);

    await users.update(operatorId, { customRoleId: null }, admin);
    await expect(roles.delete(role.id)).resolves.toMatchObject({ id: role.id });
  });

  it('isolates roles between tenants', async () => {
    const foreign = await otherRoles.create({ name: 'Foreign', permissions: ['users.manage'] });

    expect((await roles.findAll()).map((r) => r.id)).not.toContain(foreign.id);
    await expect(users.update(operatorId, { customRoleId: foreign.id }, admin)).rejects.toBeInstanceOf(NotFoundException);
    await expect(roles.update(foreign.id, { name: 'Hijacked' })).rejects.toBeInstanceOf(NotFoundException);
  });
});
