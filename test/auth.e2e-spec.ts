import { BadRequestException, ForbiddenException, UnauthorizedException, UnprocessableEntityException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Role, Tenant, TenantStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AuthService } from '../src/auth/auth.service';
import { AuthUser } from '../src/common/types/request-with-user.interface';
import { UsersService } from '../src/users/users.service';
import { PlanLimitsService } from '../src/tenancy/plan-limits.service';
import { createTestTenant, deleteTestTenant, scopedTo, testPrisma } from './support/tenancy';

process.env.JWT_SECRET ??= 'test-access-secret';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret';

describe('Auth and users (integration)', () => {
  const prisma = testPrisma();
  const jwt = new JwtService({ secret: process.env.JWT_SECRET });
  const auth = new AuthService(prisma, new UsersService(prisma, new PlanLimitsService(prisma)), jwt);
  const password = 'correct-horse-1';
  let tenant: Tenant;
  let otherTenant: Tenant;
  const users = scopedTo(new UsersService(prisma, new PlanLimitsService(prisma)), () => tenant.id);

  const createUser = async (role: Role = Role.operator, owner: Tenant = tenant, username = `u-${randomUUID().slice(0, 8)}`) =>
    prisma.user.create({
      data: {
        tenantId: owner.id,
        username,
        email: `${username}@example.com`,
        name: `User ${username}`,
        role,
        password: await bcrypt.hash(password, 4),
      },
    });
  const asActor = (user: { id: string; tenantId: string; username: string; name: string; role: Role }): AuthUser => ({
    id: user.id, sub: user.id, tenantId: user.tenantId, username: user.username, name: user.name, role: user.role, warehouseId: null,
  });
  const login = (username: string, pass = password, slug = tenant.slug) => auth.login({ tenant: slug, username, password: pass });

  beforeAll(async () => {
    [tenant, otherTenant] = await Promise.all([createTestTenant(prisma), createTestTenant(prisma)]);
  });

  afterEach(async () => {
    await prisma.user.deleteMany({ where: { tenantId: { in: [tenant.id, otherTenant.id] } } });
    await prisma.tenant.updateMany({ where: { id: { in: [tenant.id, otherTenant.id] } }, data: { status: TenantStatus.active } });
  });

  afterAll(async () => {
    await deleteTestTenant(prisma, tenant.id);
    await deleteTestTenant(prisma, otherTenant.id);
    await prisma.$disconnect();
  });

  describe('tenant resolution', () => {
    it('signs the tenant into the access token and returns it', async () => {
      const user = await createUser();
      const result = await login(user.username);

      expect(result.tenant).toMatchObject({ id: tenant.id, slug: tenant.slug });
      expect(jwt.decode<{ tenantId: string }>(result.accessToken).tenantId).toBe(tenant.id);
    });

    it('keeps the same username independent across tenants', async () => {
      const username = `shared-${randomUUID().slice(0, 8)}`;
      await createUser(Role.operator, tenant, username);
      await createUser(Role.operator, otherTenant, username);

      const [a, b] = await Promise.all([login(username), login(username, password, otherTenant.slug)]);

      expect(a.tenant.id).toBe(tenant.id);
      expect(b.tenant.id).toBe(otherTenant.id);
      expect(a.user.id).not.toBe(b.user.id);
    });

    it('rejects a user that belongs to another tenant', async () => {
      const user = await createUser(Role.operator, otherTenant);

      await expect(login(user.username)).rejects.toThrow(UnauthorizedException);
    });

    it('requires the tenant when several tenants are active', async () => {
      const user = await createUser();

      await expect(auth.login({ username: user.username, password })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('blocks login and refresh for suspended tenants', async () => {
      const user = await createUser();
      const { refreshToken } = await login(user.username);
      await prisma.tenant.update({ where: { id: tenant.id }, data: { status: TenantStatus.suspended } });

      await expect(login(user.username)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(auth.refresh(refreshToken)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('sessions', () => {
    it('stores only a hash of the refresh token', async () => {
      const user = await createUser();
      const { refreshToken } = await login(user.username);

      const stored = await prisma.refreshToken.findFirstOrThrow({ where: { userId: user.id } });
      expect(stored.tokenHash).not.toBe(refreshToken);
      expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('rejects wrong passwords and unknown users with the same error', async () => {
      const user = await createUser();

      await expect(login(user.username, 'wrong-password')).rejects.toThrow(UnauthorizedException);
      await expect(login('missing-user')).rejects.toThrow(UnauthorizedException);
    });

    it('rotates the refresh token', async () => {
      const user = await createUser();
      const first = await login(user.username);
      const second = await auth.refresh(first.refreshToken);

      expect(second.refreshToken).not.toBe(first.refreshToken);
      await expect(auth.refresh(second.refreshToken)).resolves.toHaveProperty('accessToken');
    });

    it('revokes every session when a rotated token is reused', async () => {
      const user = await createUser();
      const first = await login(user.username);
      const second = await auth.refresh(first.refreshToken);

      await expect(auth.refresh(first.refreshToken)).rejects.toMatchObject({
        response: { error: 'AUTH_REFRESH_REUSED' },
      });
      await expect(auth.refresh(second.refreshToken)).rejects.toThrow(UnauthorizedException);
    });

    it('lets only one concurrent refresh with the same token succeed', async () => {
      const user = await createUser();
      const { refreshToken } = await login(user.username);

      const results = await Promise.allSettled([auth.refresh(refreshToken), auth.refresh(refreshToken)]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    });

    it('refuses to refresh sessions of deactivated users', async () => {
      const user = await createUser();
      const { refreshToken } = await login(user.username);
      await prisma.user.update({ where: { id: user.id }, data: { active: false } });

      await expect(auth.refresh(refreshToken)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('password change', () => {
    it('requires the current password', async () => {
      const user = await createUser();

      await expect(auth.changePassword(user.id, 'wrong-password', 'new-password-1')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('updates the password and closes every open session', async () => {
      const user = await createUser();
      const { refreshToken } = await login(user.username);

      await auth.changePassword(user.id, password, 'new-password-1');

      await expect(auth.refresh(refreshToken)).rejects.toThrow(UnauthorizedException);
      await expect(login(user.username, 'new-password-1')).resolves.toHaveProperty('accessToken');
    });
  });

  describe('user administration', () => {
    it('prevents admins from deactivating themselves', async () => {
      const admin = await createUser(Role.admin);

      await expect(users.update(admin.id, { active: false }, asActor(admin))).rejects.toMatchObject({
        response: { error: 'CANNOT_MODIFY_SELF' },
      });
    });

    it('keeps at least one active admin per tenant', async () => {
      const admin = await createUser(Role.admin);
      const operator = await createUser();
      await createUser(Role.admin, otherTenant);

      await expect(users.update(admin.id, { role: Role.operator }, asActor(operator))).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });

    it('allows demoting an admin while another one remains', async () => {
      const [admin, otherAdmin] = [await createUser(Role.admin), await createUser(Role.admin)];

      await expect(users.update(otherAdmin.id, { role: Role.supervisor }, asActor(admin))).resolves.toMatchObject({
        role: Role.supervisor,
      });
    });

    it('closes the sessions of a deactivated user', async () => {
      const admin = await createUser(Role.admin);
      const operator = await createUser();
      const { refreshToken } = await login(operator.username);

      await users.update(operator.id, { active: false }, asActor(admin));

      await expect(auth.refresh(refreshToken)).rejects.toThrow(UnauthorizedException);
    });

    it('cannot update users of another tenant', async () => {
      const admin = await createUser(Role.admin);
      const foreign = await createUser(Role.operator, otherTenant);

      await expect(users.update(foreign.id, { name: 'Hijacked' }, asActor(admin))).rejects.toMatchObject({
        response: { error: 'USER_NOT_FOUND' },
      });
    });
  });
});
