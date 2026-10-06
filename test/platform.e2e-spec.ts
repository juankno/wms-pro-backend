import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma, TenantStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JwtStrategy } from '../src/auth/strategies/jwt.strategy';
import { PlatformJwtStrategy, PlatformPrincipal } from '../src/platform/platform-jwt.strategy';
import { PlatformService } from '../src/platform/platform.service';
import { PlanLimitsService } from '../src/tenancy/plan-limits.service';
import { UsersService } from '../src/users/users.service';
import { deleteTestTenant, testPrisma } from './support/tenancy';
import { AuditService } from '../src/audit/audit.service';

describe('Platform console (integration)', () => {
  const prisma = testPrisma();
  const jwt = new JwtService({ secret: process.env.JWT_SECRET });
  const platform = new PlatformService(prisma, jwt, new PlanLimitsService(prisma), new AuditService(prisma));
  const tenantStrategy = new JwtStrategy(new UsersService(prisma, new PlanLimitsService(prisma)), prisma);
  const email = `ops-${randomUUID().slice(0, 8)}@example.com`;
  const password = 'platform-password-1';
  const createdTenants: string[] = [];
  let operator: PlatformPrincipal;

  const createTenant = async () => {
    const slug = `p-${randomUUID().slice(0, 8)}`;
    const result = await platform.createTenant({
      slug,
      name: `Company ${slug}`,
      plan: 'starter',
      admin: { username: 'admin', name: 'Admin', email: `admin@${slug}.test`, password: 'tenant-admin-1' },
    }, operator);
    createdTenants.push(result.tenant.id);
    return result;
  };

  beforeAll(async () => {
    const row = await prisma.platformAdmin.create({ data: { email, name: 'Ops', password: await bcrypt.hash(password, 4) } });
    operator = { id: row.id, email: row.email, name: row.name };
  });

  afterAll(async () => {
    for (const id of createdTenants) await deleteTestTenant(prisma, id);
    await prisma.platformAuditLog.deleteMany({ where: { adminId: operator.id } });
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
      }, operator),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(await prisma.tenant.count()).toBe(before);
  });

  it('updates plan, status and limit overrides', async () => {
    const { tenant } = await createTenant();

    await platform.updateTenant(tenant.id, { plan: 'pro', limits: { users: 3 } }, operator);
    const updated = await platform.updateTenant(tenant.id, { status: TenantStatus.suspended, limits: { warehouses: null } }, operator);

    expect(updated).toMatchObject({ plan: 'pro', status: TenantStatus.suspended, settings: { limits: { users: 3, warehouses: null } } });
    expect(await platform.tenantUsage(tenant.id)).toMatchObject({ plan: 'pro', limits: { users: 3, warehouses: null }, usage: { users: 1 } });
  });

  it('keeps platform and tenant tokens apart', async () => {
    const { tenant, admin } = await createTenant();
    const { accessToken } = await platform.login(email, password);
    const platformPayload = jwt.decode<{ sub: string; scope: string }>(accessToken);
    const platformStrategy = new PlatformJwtStrategy(prisma);

    await expect(tenantStrategy.validate(platformPayload as never)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      platformStrategy.validate({ sub: admin.id, tenantId: tenant.id } as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(platformStrategy.validate(platformPayload)).resolves.toMatchObject({ email });
  });

  it('records every platform action in the platform audit log', async () => {
    const { tenant } = await createTenant();
    await platform.updateTenant(tenant.id, { plan: 'pro' }, operator, '10.0.0.1');

    const { data } = await platform.auditLog({ tenantId: tenant.id, page: 1, limit: 10 });
    expect(data.map((entry) => entry.action)).toEqual(['tenant.update', 'tenant.create']);
    expect(data[0]).toMatchObject({ adminEmail: email, ip: '10.0.0.1', details: { plan: 'pro' } });
  });

  it('opens a support session that acts as a tenant admin and is audited on both sides', async () => {
    const { tenant, admin } = await createTenant();
    const reason = 'Ticket 123: revisar inventario';

    const session = await platform.impersonate(tenant.id, { reason }, operator);
    const payload = jwt.decode<{ exp: number; iat: number; impersonatorId: string }>(session.accessToken);

    expect(session).toMatchObject({ user: { id: admin.id }, impersonator: { id: operator.id } });
    expect(session).not.toHaveProperty('refreshToken');
    expect(payload.exp - payload.iat).toBe(30 * 60);
    await expect(tenantStrategy.validate(payload as never)).resolves.toMatchObject({
      id: admin.id,
      impersonator: { id: operator.id, name: 'Ops' },
    });

    const tenantAudit = await prisma.auditLog.findFirstOrThrow({ where: { tenantId: tenant.id, action: 'impersonate' } });
    expect(tenantAudit).toMatchObject({ impersonatorId: operator.id, payload: { reason } });
    const { data } = await platform.auditLog({ tenantId: tenant.id, page: 1, limit: 1 });
    expect(data[0]).toMatchObject({ action: 'tenant.impersonate', details: { username: 'admin', reason } });
  });

  it('ends support sessions when the platform admin is deactivated', async () => {
    const { tenant } = await createTenant();
    const session = await platform.impersonate(tenant.id, { reason: 'Ticket 456: soporte' }, operator);
    const payload = jwt.decode<object>(session.accessToken);

    await prisma.platformAdmin.update({ where: { id: operator.id }, data: { active: false } });
    await expect(tenantStrategy.validate(payload as never)).rejects.toBeInstanceOf(UnauthorizedException);
    await prisma.platformAdmin.update({ where: { id: operator.id }, data: { active: true } });
  });

  it('refuses support sessions for suspended tenants', async () => {
    const { tenant } = await createTenant();
    await platform.updateTenant(tenant.id, { status: TenantStatus.suspended }, operator);

    await expect(platform.impersonate(tenant.id, { reason: 'Ticket 789: soporte' }, operator)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
