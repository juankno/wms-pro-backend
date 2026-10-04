import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Role, Tenant } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { effectivePermissions } from '../src/auth/permissions';
import { AuthUser } from '../src/common/types/request-with-user.interface';
import { InvitationsService } from '../src/invitations/invitations.service';
import { Mailer, MailMessage } from '../src/mail/mailer';
import { PrismaService } from '../src/prisma/prisma.service';
import { PlanLimitsService } from '../src/tenancy/plan-limits.service';
import { createTestTenant, deleteTestTenant, scopedTo, testPrisma } from './support/tenancy';

class CapturingMailer extends Mailer {
  sent: MailMessage[] = [];
  failNext = false;

  send(message: MailMessage) {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('SMTP down'));
    }
    this.sent.push(message);
    return Promise.resolve();
  }

  lastToken() {
    const match = /\/invitations\/([\w-]+)/.exec(this.sent.at(-1)?.text ?? '');
    if (!match) throw new Error('No invitation link was sent');
    return match[1];
  }
}

async function createAdmin(prisma: PrismaService, tenantId: string): Promise<AuthUser> {
  const row = await prisma.user.create({
    data: { tenantId, username: 'admin', email: 'admin@invite.test', name: 'Ana', password: 'unused', role: Role.admin },
  });
  return {
    id: row.id, sub: row.id, tenantId, username: 'admin', name: 'Ana',
    role: Role.admin, warehouseId: null, permissions: effectivePermissions(Role.admin),
  };
}

describe('User invitations (integration)', () => {
  const prisma = testPrisma();
  const mailer = new CapturingMailer();
  const service = new InvitationsService(prisma, new PlanLimitsService(prisma), mailer);
  let tenant: Tenant;
  let other: Tenant;
  let admin: AuthUser;
  let otherAdmin: AuthUser;
  const invitations = scopedTo(service, () => tenant.id);
  const otherInvitations = scopedTo(service, () => other.id);

  beforeAll(async () => {
    [tenant, other] = await Promise.all([createTestTenant(prisma), createTestTenant(prisma)]);
    [admin, otherAdmin] = await Promise.all([tenant, other].map((t) => createAdmin(prisma, t.id)));
  });

  beforeEach(() => {
    mailer.sent = [];
  });

  afterAll(async () => {
    await deleteTestTenant(prisma, tenant.id);
    await deleteTestTenant(prisma, other.id);
    await prisma.$disconnect();
  });

  it('creates the user with the invited role once the invitation is accepted', async () => {
    const invitation = await invitations.invite({ email: 'Nuevo@Invite.test', role: Role.supervisor }, admin);
    expect(invitation).toMatchObject({ email: 'nuevo@invite.test', emailSent: true });
    expect(mailer.sent[0].text).toContain('Ana te invitó');

    const token = mailer.lastToken();
    expect(await service.preview(token)).toMatchObject({ email: 'nuevo@invite.test', tenant: { slug: tenant.slug } });

    const result = await service.accept(token, { username: 'nuevo', name: 'Nuevo', password: 'secreto123' });
    expect(result).toEqual({ username: 'nuevo', tenant: { name: tenant.name, slug: tenant.slug } });

    const user = await prisma.user.findUniqueOrThrow({ where: { tenantId_username: { tenantId: tenant.id, username: 'nuevo' } } });
    expect(user).toMatchObject({ email: 'nuevo@invite.test', role: Role.supervisor });
    expect(await invitations.findPending()).toHaveLength(0);
  });

  it('accepts a token only once', async () => {
    await invitations.invite({ email: 'once@invite.test', role: Role.operator }, admin);
    const token = mailer.lastToken();
    await service.accept(token, { username: 'once', name: 'Once', password: 'secreto123' });

    await expect(service.accept(token, { username: 'twice', name: 'Twice', password: 'secreto123' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects emails that already belong to a user', async () => {
    await expect(invitations.invite({ email: 'ADMIN@invite.test', role: Role.operator }, admin)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('invalidates the previous link when the invitation is resent', async () => {
    const invitation = await invitations.invite({ email: 'resend@invite.test', role: Role.operator }, admin);
    const firstToken = mailer.lastToken();

    await invitations.resend(invitation.id, admin);

    await expect(service.preview(firstToken)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.preview(mailer.lastToken())).resolves.toMatchObject({ email: 'resend@invite.test' });
  });

  it('keeps the invitation when delivery fails so it can be resent', async () => {
    mailer.failNext = true;
    const invitation = await invitations.invite({ email: 'offline@invite.test', role: Role.operator }, admin);

    expect(invitation.emailSent).toBe(false);
    expect((await invitations.findPending()).map((i) => i.id)).toContain(invitation.id);
  });

  it('rejects revoked and expired invitations', async () => {
    const revoked = await invitations.invite({ email: 'revoked@invite.test', role: Role.operator }, admin);
    const revokedToken = mailer.lastToken();
    await invitations.revoke(revoked.id);
    await expect(service.preview(revokedToken)).rejects.toBeInstanceOf(NotFoundException);

    const expired = await invitations.invite({ email: 'expired@invite.test', role: Role.operator }, admin);
    await prisma.userInvitation.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(service.preview(mailer.lastToken())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses invitations of suspended tenants', async () => {
    await otherInvitations.invite({ email: 'suspended@invite.test', role: Role.operator }, otherAdmin);
    const token = mailer.lastToken();
    await prisma.tenant.update({ where: { id: other.id }, data: { status: 'suspended' } });

    await expect(service.preview(token)).rejects.toBeInstanceOf(ForbiddenException);
    await prisma.tenant.update({ where: { id: other.id }, data: { status: 'active' } });
  });

  it('isolates invitations between tenants', async () => {
    const foreign = await otherInvitations.invite({ email: 'foreign@invite.test', role: Role.operator }, otherAdmin);

    expect((await invitations.findPending()).map((i) => i.id)).not.toContain(foreign.id);
    await expect(invitations.revoke(foreign.id)).rejects.toBeInstanceOf(NotFoundException);
  });
});
