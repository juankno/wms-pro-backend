import {
  Body, Controller, Get, Param, Patch, Post, UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags,
} from '@nestjs/swagger';
import { IsEmail, IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { Role } from '@prisma/client';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

class CreateUserDto {
  @IsString() username!: string;
  @IsString() name!: string;
  @IsEmail() email!: string;
  @IsString() @MinLength(6) password!: string;
  @IsEnum(Role) role!: Role;
  @IsOptional() @IsString() warehouseId?: string;
}

class UpdateUserDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MinLength(6) password?: string;
  @IsOptional() @IsEnum(Role) role?: Role;
  @IsOptional() @IsString() warehouseId?: string;
  @IsOptional() active?: boolean;
}

@ApiTags('users')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('users')
export class UsersController {
  constructor(private usersService: UsersService) {}

  @Get()
  @Roles('admin', 'supervisor')
  @ApiOperation({ summary: 'Listar todos los usuarios' })
  @ApiResponse({ status: 200, description: 'Lista de usuarios' })
  findAll() {
    return this.usersService.findAll();
  }

  @Get('warehouse/:warehouseId')
  @ApiOperation({ summary: 'Usuarios activos de un almacén' })
  @ApiParam({ name: 'warehouseId', example: '4f749c36-91a8-4e0f-928f-d8915c2ba8ec' })
  @ApiResponse({ status: 200, description: 'Lista de usuarios del almacén' })
  findByWarehouse(@Param('warehouseId') warehouseId: string) {
    return this.usersService.findByWarehouse(warehouseId);
  }

  @Post()
  @Roles('admin')
  @ApiOperation({ summary: 'Crear usuario (solo admin)' })
  @ApiResponse({ status: 201, description: 'Usuario creado' })
  create(@Body() dto: CreateUserDto) {
    return this.usersService.create(dto);
  }

  @Patch(':id')
  @Roles('admin')
  @ApiOperation({ summary: 'Actualizar o activar/desactivar usuario (solo admin)' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Usuario actualizado' })
  update(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.usersService.update(id, dto);
  }
}
