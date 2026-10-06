import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags, PartialType } from '@nestjs/swagger';
import { ArrayUnique, IsArray, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { ALL_PERMISSIONS, Permission } from '../auth/permissions';
import { RequirePermissions } from '../auth/permissions.decorator';
import { RolesService } from './roles.service';

class CreateRoleDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(50) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) description?: string;

  @ApiProperty({ enum: ALL_PERMISSIONS, isArray: true })
  @IsArray()
  @ArrayUnique()
  @IsIn(ALL_PERMISSIONS, { each: true })
  permissions!: Permission[];
}

class UpdateRoleDto extends PartialType(CreateRoleDto) {}

@ApiTags('roles')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('roles.manage')
@Controller('roles')
export class RolesController {
  constructor(private roles: RolesService) {}

  @Get('catalog')
  @ApiOperation({ summary: 'Permisos disponibles y permisos de los roles base' })
  catalog() {
    return this.roles.catalog();
  }

  @Get()
  @ApiOperation({ summary: 'Roles personalizados de la empresa' })
  findAll() {
    return this.roles.findAll();
  }

  @Post()
  @ApiOperation({ summary: 'Crear rol personalizado' })
  create(@Body() dto: CreateRoleDto) {
    return this.roles.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Editar rol personalizado' })
  update(@Param('id') id: string, @Body() dto: UpdateRoleDto) {
    return this.roles.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Eliminar rol personalizado sin usuarios asignados' })
  async remove(@Param('id') id: string) {
    await this.roles.delete(id);
  }
}
