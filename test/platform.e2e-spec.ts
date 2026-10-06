import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma, TenantStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JwtStrategy } from '../src/auth/strategies/jwt.strategy';
import { PlatformJwtStrategy } from '../src/platform/platform-jwt.strategy';
import { PlatformService } from '../src/platform/platform.service';
import { PlanLimitsService } from '../src/tenancy/plan-limits.service';
import { UsersService } from '../src/users/users.service';
import { deleteTestTenant, testPrisma } from './support/tenancy';

describe('Platform console (integration)', () => {
  const prisma = testPrisma();
  const jwt = new JwtService({ secret: process.env.JWT_SECRET });
  const platform = new PlatformService(prisma, jwt, new PlanLimitsService(prisma));
  const email = `ops-${randomUUID().slice(0, 8)}@example.com`;
  const password = 'platform-password-1';
  const createdTenants: string[] = [];

  const createTenant = async () => {
    const slug = `p-${randomUUID().slice(0, 8)}`;
    const result = await platform.createTenant({
      slug,
      name: `Company ${slug}`,
      plan: 'starter',
      admin: { username: 'admin', name: 'Admin', email: `admin@${slug}.test`, password: 'tenant-admin-1' },
    });
    createdTenants.push(result.tenant.id);
    return result;
  };

  beforeAll(async () => {
    await prisma.platformAdmin.create({ data: { email, name: 'Ops', password: await bcrypt.hash(password, 4) } });
  });

  afterAll(async () => {
    for (const id of createdTenants) await deleteTestTenant(prisma, id);
    await prisma.platformAdmin.deleteMany({ where: { email } });
    await prisma.$disconnect();
  });

  it('logs in platform admins with a platform-scoped token', async () => {
    const { accessToken } = await platform.login(email.toUpperCase(), password);

    expect(jwt.decode<{ scope: string }>(accessToken).scope).toBe('platform');
    await expect(platform.login(email, 'wrong-password')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('creates a tenant with its first admin atomically', async () => {
    const { tenant, admin } = await createTenant();

    expect(tenant).toMatchObject({ plan: 'starter', status: TenantStatus.active });
    expect(admin).toMatchObject({ role: 'admin', username: 'admin' });
    expect(await prisma.user.count({ where: { tenantId: tenant.id } })).toBe(1);
  });

  it('rejects a duplicated slug without creating anything', async () => {
    const { tenant } = await createTenant();
    const before = await prisma.tenant.count();

    await expect(
      platform.createTenant({
        slug: tenant.slug,
        name: 'Duplicate',
        admin: { username: 'x', name: 'X', email: 'x@x.test', password: 'tenant-admin-1' },
      }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(await prisma.tenant.count()).toBe(before);
  });

  it('updates plan, status and limit overrides', async () => {
    const { tenant } = await createTenant();

    await platform.updateTenant(tenant.id, { plan: 'pro', limits: { users: 3 } });
    const updated = await platform.updateTenant(tenant.id, { status: TenantStatus.suspended, limits: { warehouses: null } });

    expect(updated).toMatchObject({ plan: 'pro', status: TenantStatus.suspended, settings: { limits: { users: 3, warehouses: null } } });
    expect(await platform.tenantUsage(tenant.id)).toMatchObject({ plan: 'pro', limits: { users: 3, warehouses: null }, usage: { users: 1 } });
  });

  it('keeps platform and tenant tokens apart', async () => {
    const { tenant, admin } = await createTenant();
    const { accessToken } = await platform.login(email, password);
    const platformPayload = jwt.decode<{ sub: string; scope: string }>(accessToken);
    const tenantStrategy = new JwtStrategy(new UsersService(prisma, new PlanLimitsService(prisma)));
    const platformStrategy = new PlatformJwtStrategy(prisma);

    await expect(tenantStrategy.validate(platformPayload as never)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      platformStrategy.validate({ sub: admin.id, tenantId: tenant.id } as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(platformStrategy.validate(platformPayload)).resolves.toMatchObject({ email });
  });
});
