import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/request-with-user.interface';
import { AcceptInvitationDto, CreateInvitationDto } from './dto/invitation.dto';
import { InvitationsService } from './invitations.service';

const PUBLIC_RATE_LIMIT = { limit: 10, ttl: 60_000 };

@ApiTags('users')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('users.manage')
@Controller('users/invitations')
export class InvitationsController {
  constructor(private invitations: InvitationsService) {}

  @Get()
  @ApiOperation({ summary: 'Invitaciones pendientes de la empresa' })
  findPending() {
    return this.invitations.findPending();
  }

  @Post()
  @ApiOperation({ summary: 'Invitar a un usuario por correo' })
  invite(@Body() dto: CreateInvitationDto, @CurrentUser() user: AuthUser) {
    return this.invitations.invite(dto, user);
  }

  @Post(':id/resend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reenviar la invitación con un enlace nuevo' })
  resend(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.invitations.resend(id, user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revocar una invitación pendiente' })
  async revoke(@Param('id') id: string) {
    await this.invitations.revoke(id);
  }
}

@ApiTags('invitations')
@Throttle({ default: PUBLIC_RATE_LIMIT })
@Controller('invitations')
export class PublicInvitationsController {
  constructor(private invitations: InvitationsService) {}

  @Get(':token')
  @ApiOperation({ summary: 'Datos de una invitación para mostrar antes de aceptarla' })
  preview(@Param('token') token: string) {
    return this.invitations.preview(token);
  }

  @Post(':token/accept')
  @ApiOperation({ summary: 'Aceptar la invitación creando usuario y contraseña' })
  accept(@Param('token') token: string, @Body() dto: AcceptInvitationDto) {
    return this.invitations.accept(token, dto);
  }
}
