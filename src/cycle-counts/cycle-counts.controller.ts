import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { CycleCountStatus } from '@prisma/client';
import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { PaginationDto } from '../common/dto/pagination.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/request-with-user.interface';
import { scopeWarehouseFilter } from '../common/utils/warehouse-scope';
import { CycleCountsService } from './cycle-counts.service';

const MAX_SCOPE = 500;

class CreateCycleCountDto {
  @ApiProperty() @IsString() @IsNotEmpty() warehouseId!: string;

  @ApiPropertyOptional({ type: [String], description: 'Count everything stored in these locations' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_SCOPE)
  @IsString({ each: true })
  locationIds?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Count these products in every location and without location' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_SCOPE)
  @IsString({ each: true })
  productIds?: string[];

  @ApiPropertyOptional({ default: false, description: 'Hide expected quantities from counters' }) @IsOptional() @IsBoolean() blind?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

class RecordCountDto {
  @ApiProperty({ minimum: 0 }) @IsInt() @Min(0) countedQuantity!: number;
  @ApiPropertyOptional({ description: 'Lot of extra units of lot-tracked products' }) @IsOptional() @IsString() @MaxLength(50) lotCode?: string;
}

class AddCountLineDto extends RecordCountDto {
  @ApiProperty() @IsString() @IsNotEmpty() productId!: string;
  @ApiPropertyOptional({ description: 'Omit for units without location' }) @IsOptional() @IsString() locationId?: string;
}

class CycleCountQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: CycleCountStatus }) @IsOptional() @IsEnum(CycleCountStatus) status?: CycleCountStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() warehouseId?: string;
}

@ApiTags('cycle-counts')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('cycle-counts')
export class CycleCountsController {
  constructor(private counts: CycleCountsService) {}

  @Get()
  @ApiOperation({ summary: 'Conteos de inventario' })
  findAll(@Query() query: CycleCountQueryDto, @CurrentUser() user: AuthUser) {
    return this.counts.findAll({ ...query, warehouseId: scopeWarehouseFilter(user, query.warehouseId) });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle con líneas en orden de recorrido y diferencias' })
  findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.counts.findById(id, user);
  }

  @Post()
  @RequirePermissions('counts.manage')
  @ApiOperation({ summary: 'Crear conteo por ubicaciones o por productos (guarda lo esperado al iniciar)' })
  create(@Body() dto: CreateCycleCountDto, @CurrentUser() user: AuthUser) {
    return this.counts.create(dto, user);
  }

  @Patch(':id/lines/:lineId')
  @ApiOperation({ summary: 'Registrar la cantidad contada de una línea' })
  record(@Param('id') id: string, @Param('lineId') lineId: string, @Body() dto: RecordCountDto, @CurrentUser() user: AuthUser) {
    return this.counts.recordCount(id, lineId, dto, user);
  }

  @Post(':id/lines')
  @ApiOperation({ summary: 'Agregar un producto encontrado que no estaba en el conteo' })
  addLine(@Param('id') id: string, @Body() dto: AddCountLineDto, @CurrentUser() user: AuthUser) {
    return this.counts.addLine(id, dto, user);
  }

  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Enviar a revisión con todas las líneas contadas' })
  submit(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.counts.submit(id, user);
  }

  @Post(':id/reopen')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('counts.manage')
  @ApiOperation({ summary: 'Devolver a conteo para recontar' })
  reopen(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.counts.reopen(id, user);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('counts.manage')
  @ApiOperation({ summary: 'Aprobar: aplica las diferencias como ajustes de stock' })
  approve(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.counts.approve(id, user);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('counts.manage')
  @ApiOperation({ summary: 'Cancelar sin ajustar el stock' })
  cancel(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.counts.cancel(id, user);
  }
}
