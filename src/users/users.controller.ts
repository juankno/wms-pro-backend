import {
  Body, Controller, Get, Param, Patch, Post, UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags,
} from '@nestjs/swagger';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/request-with-user.interface';
import { assertWarehouseAccess } from '../common/utils/warehouse-scope';
import { CreateUserDto, UpdateUserDto } from './dto/user.dto';
import { RequirePermissions } from '../auth/permissions.decorator';

@ApiTags('users')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('users')
export class UsersController {
  constructor(private usersService: UsersService) {}

  @Get()
  @RequirePermissions('users.read')
  @ApiOperation({ summary: 'Listar todos los usuarios' })
  @ApiResponse({ status: 200, description: 'Lista de usuarios' })
  findAll() {
    return this.usersService.findAll();
  }

  @Get('warehouse/:warehouseId')
  @ApiOperation({ summary: 'Usuarios activos de un almacén' })
  @ApiParam({ name: 'warehouseId', example: '4f749c36-91a8-4e0f-928f-d8915c2ba8ec' })
  @ApiResponse({ status: 200, description: 'Lista de usuarios del almacén' })
  findByWarehouse(@Param('warehouseId') warehouseId: string, @CurrentUser() user: AuthUser) {
    assertWarehouseAccess(user, warehouseId);
    return this.usersService.findByWarehouse(warehouseId);
  }

  @Post()
  @RequirePermissions('users.manage')
  @ApiOperation({ summary: 'Crear usuario (solo admin)' })
  @ApiResponse({ status: 201, description: 'Usuario creado' })
  create(@Body() dto: CreateUserDto) {
    return this.usersService.create(dto);
  }

  @Patch(':id')
  @RequirePermissions('users.manage')
  @ApiOperation({ summary: 'Actualizar o activar/desactivar usuario (solo admin)' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Usuario actualizado' })
  update(@Param('id') id: string, @Body() dto: UpdateUserDto, @CurrentUser() user: AuthUser) {
    return this.usersService.update(id, dto, user);
  }
}
