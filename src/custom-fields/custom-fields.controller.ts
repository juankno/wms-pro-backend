import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { CustomFieldEntity, CustomFieldType } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { CustomFieldsService } from './custom-fields.service';

class CustomFieldOptionsDto {
  @ApiPropertyOptional({ type: [String], description: 'Choices of a select field' })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  options?: string[];

  @ApiPropertyOptional() @IsOptional() @IsBoolean() required?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) sortOrder?: number;
}

class CreateCustomFieldDto extends CustomFieldOptionsDto {
  @ApiProperty({ enum: CustomFieldEntity }) @IsEnum(CustomFieldEntity) entity!: CustomFieldEntity;

  @ApiProperty({ example: 'pais_origen', description: 'Lowercase letters, digits and underscores; fixed after creation' })
  @Matches(/^[a-z][a-z0-9_]{0,39}$/, { message: 'La clave usa minúsculas, números y guion bajo, y empieza con letra' })
  key!: string;

  @ApiProperty({ example: 'País de origen' }) @IsString() @IsNotEmpty() @MaxLength(60) label!: string;
  @ApiProperty({ enum: CustomFieldType }) @IsEnum(CustomFieldType) type!: CustomFieldType;
}

class UpdateCustomFieldDto extends CustomFieldOptionsDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @IsNotEmpty() @MaxLength(60) label?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() active?: boolean;
}

class CustomFieldQueryDto {
  @ApiPropertyOptional({ enum: CustomFieldEntity }) @IsOptional() @IsEnum(CustomFieldEntity) entity?: CustomFieldEntity;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeInactive?: boolean;
}

@ApiTags('custom-fields')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('custom-fields')
export class CustomFieldsController {
  constructor(private fields: CustomFieldsService) {}

  @Get()
  @ApiOperation({ summary: 'Campos personalizados de productos, clientes/proveedores o ubicaciones' })
  findAll(@Query() query: CustomFieldQueryDto) {
    return this.fields.findAll(query.entity, query.includeInactive);
  }

  @Post()
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'Crear campo personalizado' })
  create(@Body() dto: CreateCustomFieldDto) {
    return this.fields.create(dto);
  }

  @Patch(':id')
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'Editar etiqueta, opciones, obligatoriedad, orden o desactivar' })
  update(@Param('id') id: string, @Body() dto: UpdateCustomFieldDto) {
    return this.fields.update(id, dto);
  }
}
