import { UnauthorizedException, UnprocessableEntityException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AuthService } from '../src/auth/auth.service';
import { AuthUser } from '../src/common/types/request-with-user.interface';
import { PrismaService } from '../src/prisma/prisma.service';
import { UsersService } from '../src/users/users.service';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error('TEST_DATABASE_URL must point to a disposable database');
}

process.env.JWT_SECRET ??= 'test-access-secret';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret';

describe('Auth and users (integration)', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } }) as PrismaService;
  const users = new UsersService(prisma);
  const auth = new AuthService(prisma, users, new JwtService({ secret: process.env.JWT_SECRET }));
  const password = 'correct-horse-1';
  const createdUserIds: string[] = [];

  const createUser = async (role: Role = Role.operator) => {
    const suffix = randomUUID().slice(0, 8);
    const user = await prisma.user.create({
      data: {
        username: `u-${suffix}`,
        email: `u-${suffix}@example.com`,
        name: `User ${suffix}`,
        role,
        password: await bcrypt.hash(password, 4),
      },
    });
    createdUserIds.push(user.id);
    return user;
  };
  const asActor = (user: { id: string; username: string; name: string; role: Role }): AuthUser => ({
    id: user.id, sub: user.id, username: user.username, name: user.name, role: user.role, warehouseId: null,
  });
  const login = (username: string, pass = password) => auth.login({ username, password: pass });

  beforeAll(async () => {
    const admins = await prisma.user.count({ where: { role: Role.admin, active: true } });
    if (admins > 0) throw new Error('The test database must not contain active admins');
  });

  afterEach(async () => {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds.splice(0) } } });
  });

  afterAll(() => prisma.$disconnect());

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

    it('keeps at least one active admin', async () => {
      const admin = await createUser(Role.admin);
      const operator = await createUser();

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
  });
});
