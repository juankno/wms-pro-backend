import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { UpdatePushTokenDto } from './dto/update-push-token.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/request-with-user.interface';
import { RejectImpersonationGuard } from './guards/reject-impersonation.guard';

const AUTH_RATE_LIMIT = { limit: 10, ttl: 60_000 };

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('login')
  @Throttle({ default: AUTH_RATE_LIMIT })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Iniciar sesión',
    description: 'Autentica un usuario y devuelve access token (1h) y refresh token (30d).',
  })
  @ApiResponse({
    status: 200,
    description: 'Login exitoso',
    schema: {
      example: {
        accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        refreshToken: 'b0d4a15f-38b5-4723-a83e-ffa35b2360b6',
        expiresIn: 3600,
        user: {
          id: 'ebe9a6f3-d616-46a9-af58-4ed21e4525f0',
          name: 'Juan Operario',
          role: 'operator',
          warehouseId: '4f749c36-91a8-4e0f-928f-d8915c2ba8ec',
          warehouseName: 'Bodega Principal Bogotá',
        },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Credenciales inválidas',
    schema: { example: { error: 'AUTH_INVALID_CREDENTIALS', message: 'Usuario o contraseña incorrectos' } },
  })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('refresh')
  @Throttle({ default: AUTH_RATE_LIMIT })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Renovar access token',
    description: 'Intercambia un refresh token válido por un nuevo par de tokens. El refresh token usado queda invalidado.',
  })
  @ApiResponse({
    status: 200,
    description: 'Tokens renovados',
    schema: {
      example: {
        accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        refreshToken: 'c1e5b26g-49c6-5834-b94f-ggb46c3636g7',
        expiresIn: 3600,
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Refresh token expirado o revocado — el usuario debe hacer login nuevamente',
    schema: { example: { error: 'AUTH_REFRESH_EXPIRED', message: 'Sesión expirada. Inicia sesión nuevamente.' } },
  })
  refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  @UseGuards(JwtAuthGuard, RejectImpersonationGuard)
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Cerrar sesión',
    description: 'Invalida todos los refresh tokens activos del usuario. El access token sigue siendo válido hasta su expiración natural.',
  })
  @ApiResponse({ status: 204, description: 'Sesión cerrada correctamente' })
  @ApiResponse({ status: 401, description: 'Token inválido o expirado', schema: { example: { error: 'AUTH_TOKEN_EXPIRED', message: 'Token inválido o expirado' } } })
  logout(@CurrentUser() user: AuthUser) {
    return this.authService.logout(user.id);
  }

  @UseGuards(JwtAuthGuard, RejectImpersonationGuard)
  @Patch('me/push-token')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Actualizar token de notificaciones push',
    description: 'Registra o actualiza el token de Expo Notifications del dispositivo actual. Llamar en cada login.',
  })
  @ApiResponse({ status: 200, description: 'Push token actualizado' })
  @ApiResponse({ status: 401, description: 'Token inválido', schema: { example: { error: 'AUTH_TOKEN_EXPIRED', message: 'Token inválido o expirado' } } })
  updatePushToken(@CurrentUser() user: AuthUser, @Body() dto: UpdatePushTokenDto) {
    return this.authService.updatePushToken(user.id, dto.pushToken);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Perfil del usuario autenticado' })
  @ApiResponse({ status: 200, description: 'Perfil del usuario' })
  async me(@CurrentUser() user: AuthUser) {
    return { ...(await this.authService.me(user.id)), impersonator: user.impersonator ?? null };
  }

  @UseGuards(JwtAuthGuard, RejectImpersonationGuard)
  @Patch('me/password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: AUTH_RATE_LIMIT })
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Cambiar la contraseña propia',
    description: 'Requiere la contraseña actual. Cierra todas las sesiones abiertas (revoca los refresh tokens).',
  })
  @ApiResponse({ status: 204, description: 'Contraseña actualizada' })
  @ApiResponse({ status: 401, description: 'Contraseña actual incorrecta', schema: { example: { error: 'AUTH_INVALID_PASSWORD', message: 'La contraseña actual no es correcta' } } })
  changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto) {
    return this.authService.changePassword(user.id, dto.currentPassword, dto.newPassword);
  }
}
