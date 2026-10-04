import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CreateTenantDto, PlatformLoginDto, UpdateTenantDto } from './dto/platform.dto';
import { PlatformService } from './platform.service';

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
  createTenant(@Body() dto: CreateTenantDto) {
    return this.platform.createTenant(dto);
  }

  @Patch('tenants/:id')
  @UseGuards(AuthGuard('platform-jwt'))
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Cambiar nombre, plan, estado o límites de una empresa' })
  updateTenant(@Param('id') id: string, @Body() dto: UpdateTenantDto) {
    return this.platform.updateTenant(id, dto);
  }

  @Get('tenants/:id/usage')
  @UseGuards(AuthGuard('platform-jwt'))
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Uso de una empresa frente a su plan' })
  tenantUsage(@Param('id') id: string) {
    return this.platform.tenantUsage(id);
  }
}
