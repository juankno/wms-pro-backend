import { Body, Controller, Get, HttpCode, HttpStatus, Ip, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CreateTenantDto, ImpersonateDto, PlatformAuditQueryDto, PlatformLoginDto, UpdateTenantDto } from './dto/platform.dto';
import { PlatformService } from './platform.service';
import { CurrentPlatformAdmin } from './current-platform-admin.decorator';
import { PlatformPrincipal } from './platform-jwt.strategy';

const PLATFORM_LOGIN_RATE_LIMIT = { limit: 5, ttl: 60_000 };

@ApiTags('platform')
@Controller('platform')
export class PlatformController {
  constructor(private platform: PlatformService) {}

  @Post('auth/login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: PLATFORM_LOGIN_RATE_LIMIT })
  @ApiOperation({ summary: 'Login de administradores de la plataforma' })
  login(@Body() dto: PlatformLoginDto) {
    return this.platform.login(dto.email, dto.password);
  }

  @Get('tenants')
  @UseGuards(AuthGuard('platform-jwt'))
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Empresas con plan, límites y conteos' })
  listTenants() {
    return this.platform.listTenants();
  }

  @Post('tenants')
  @UseGuards(AuthGuard('platform-jwt'))
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Crear empresa con su primer administrador' })
  createTenant(@Body() dto: CreateTenantDto, @CurrentPlatformAdmin() admin: PlatformPrincipal, @Ip() ip: string) {
    return this.platform.createTenant(dto, admin, ip);
  }

  @Patch('tenants/:id')
  @UseGuards(AuthGuard('platform-jwt'))
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Cambiar nombre, plan, estado o límites de una empresa' })
  updateTenant(
    @Param('id') id: string,
    @Body() dto: UpdateTenantDto,
    @CurrentPlatformAdmin() admin: PlatformPrincipal,
    @Ip() ip: string,
  ) {
    return this.platform.updateTenant(id, dto, admin, ip);
  }

  @Post('tenants/:id/impersonate')
  @UseGuards(AuthGuard('platform-jwt'))
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Entrar a una empresa como soporte',
    description: 'Token de 30 minutos sin refresh que actúa como un usuario de la empresa. Queda en ambas auditorías.',
  })
  impersonate(
    @Param('id') id: string,
    @Body() dto: ImpersonateDto,
    @CurrentPlatformAdmin() admin: PlatformPrincipal,
    @Ip() ip: string,
  ) {
    return this.platform.impersonate(id, dto, admin, ip);
  }

  @Get('audit')
  @UseGuards(AuthGuard('platform-jwt'))
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Acciones de los administradores de la plataforma' })
  auditLog(@Query() query: PlatformAuditQueryDto) {
    return this.platform.auditLog(query);
  }

  @Get('tenants/:id/usage')
  @UseGuards(AuthGuard('platform-jwt'))
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Uso de una empresa frente a su plan' })
  tenantUsage(@Param('id') id: string) {
    return this.platform.tenantUsage(id);
  }
}
