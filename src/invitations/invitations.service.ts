import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, Role, TenantStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { AuthUser } from '../common/types/request-with-user.interface';
import { mailConfig } from '../config/env';
import { Mailer } from '../mail/mailer';
import { PrismaService } from '../prisma/prisma.service';
import { PlanLimitsService } from '../tenancy/plan-limits.service';
import { requireTenantId, runInTenant } from '../tenancy/tenant-context';
import { invitationEmail } from './invitation-email';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const INVITATION_SELECT = {
  id: true,
  email: true,
  role: true,
  expiresAt: true,
  createdAt: true,
  customRole: { select: { id: true, name: true } },
  warehouse: { select: { id: true, name: true } },
  invitedBy: { select: { id: true, name: true } },
} satisfies Prisma.UserInvitationSelect;

const INVITATION_INVALID = {
  error: 'INVITATION_INVALID',
  message: 'La invitación no existe, venció o ya fue usada',
};

// Tokens carry 256 random bits, so a fast hash is enough to keep them unusable if the table leaks.
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);

  constructor(
    private prisma: PrismaService,
    private planLimits: PlanLimitsService,
    private mailer: Mailer,
  ) {}

  async invite(
    data: { email: string; role: Role; customRoleId?: string; warehouseId?: string },
    actor: AuthUser,
  ) {
    const email = data.email.trim().toLowerCase();
    const existing = await this.prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
    if (existing) {
      throw new ConflictException({ error: 'EMAIL_IN_USE', message: 'Ya existe un usuario con ese correo' });
    }
    await this.planLimits.assertCanCreate('users');
    await this.assertReferencesExist(data.customRoleId, data.warehouseId);

    await this.prisma.userInvitation.deleteMany({ where: { email, acceptedAt: null } });
    const token = randomBytes(32).toString('base64url');
    const invitation = await this.prisma.userInvitation.create({
      data: {
        tenantId: requireTenantId(),
        email,
        role: data.role,
        customRoleId: data.customRoleId,
        warehouseId: data.warehouseId,
        invitedById: actor.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
      },
      select: INVITATION_SELECT,
    });
    return { ...invitation, emailSent: await this.deliver(invitation, token, actor) };
  }

  findPending() {
    return this.prisma.userInvitation.findMany({
      where: { acceptedAt: null },
      select: INVITATION_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  async resend(id: string, actor: AuthUser) {
    await this.findPendingById(id);
    const token = randomBytes(32).toString('base64url');
    const invitation = await this.prisma.userInvitation.update({
      where: { id },
      data: { tokenHash: hashToken(token), expiresAt: new Date(Date.now() + INVITATION_TTL_MS) },
      select: INVITATION_SELECT,
    });
    return { ...invitation, emailSent: await this.deliver(invitation, token, actor) };
  }

  async revoke(id: string) {
    const { count } = await this.prisma.userInvitation.deleteMany({ where: { id, acceptedAt: null } });
    if (count === 0) throw this.notFound();
  }

  async preview(token: string) {
    const invitation = await this.findValidByToken(token);
    return {
      email: invitation.email,
      role: invitation.role,
      customRole: invitation.customRole && { name: invitation.customRole.name },
      tenant: { name: invitation.tenant.name, slug: invitation.tenant.slug },
      expiresAt: invitation.expiresAt,
    };
  }

  async accept(token: string, data: { username: string; name: string; password: string }) {
    const invitation = await this.findValidByToken(token);
    const password = await bcrypt.hash(data.password, 10);

    return runInTenant(invitation.tenantId, async () => {
      await this.planLimits.assertCanCreate('users');
      await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.userInvitation.updateMany({
          where: { id: invitation.id, acceptedAt: null },
          data: { acceptedAt: new Date() },
        });
        if (count === 0) throw new NotFoundException(INVITATION_INVALID);
        await tx.user.create({
          data: {
            tenantId: invitation.tenantId,
            username: data.username,
            name: data.name,
            email: invitation.email,
            password,
            role: invitation.role,
            customRoleId: invitation.customRoleId,
            warehouseId: invitation.warehouseId,
          },
        });
      });
      return { username: data.username, tenant: { name: invitation.tenant.name, slug: invitation.tenant.slug } };
    });
  }

  private async findValidByToken(token: string) {
    const invitation = await this.prisma.userInvitation.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { tenant: true, customRole: { select: { name: true } } },
    });
    if (!invitation || invitation.acceptedAt || invitation.expiresAt < new Date()) {
      throw new NotFoundException(INVITATION_INVALID);
    }
    if (invitation.tenant.status !== TenantStatus.active) {
      throw new ForbiddenException({ error: 'TENANT_SUSPENDED', message: 'La cuenta de la empresa está suspendida' });
    }
    return invitation;
  }

  private async findPendingById(id: string) {
    const invitation = await this.prisma.userInvitation.findFirst({ where: { id, acceptedAt: null } });
    if (!invitation) throw this.notFound();
    return invitation;
  }

  // Both lookups go through the tenant-scoped client, so references of another tenant are not found.
  private async assertReferencesExist(customRoleId?: string, warehouseId?: string) {
    if (customRoleId && !(await this.prisma.tenantRole.findUnique({ where: { id: customRoleId } }))) {
      throw new NotFoundException({ error: 'ROLE_NOT_FOUND', message: 'Rol no encontrado' });
    }
    if (warehouseId && !(await this.prisma.warehouse.findUnique({ where: { id: warehouseId } }))) {
      throw new NotFoundException({ error: 'WAREHOUSE_NOT_FOUND', message: 'Almacén no encontrado' });
    }
  }

  // A failed delivery keeps the invitation so it can be resent; the caller sees emailSent: false.
  private async deliver(invitation: { email: string; expiresAt: Date }, token: string, actor: AuthUser) {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: requireTenantId() } });
    const message = invitationEmail({
      to: invitation.email,
      tenantName: tenant.name,
      inviterName: actor.name,
      acceptUrl: `${mailConfig().appUrl}/invitations/${token}`,
      expiresAt: invitation.expiresAt,
    });
    try {
      await this.mailer.send(message);
      return true;
    } catch (error) {
      this.logger.error(`Invitation email to ${invitation.email} failed: ${String(error)}`);
      return false;
    }
  }

  private notFound() {
    return new NotFoundException({ error: 'INVITATION_NOT_FOUND', message: 'Invitación no encontrada' });
  }
}
