import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { WaveStatus } from '@prisma/client';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsEnum, IsInt, IsNotEmpty, IsOptional, IsPositive, IsString } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { PaginationDto } from '../common/dto/pagination.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/request-with-user.interface';
import { scopeWarehouseFilter } from '../common/utils/warehouse-scope';
import { WavesService } from './waves.service';

const MAX_ORDERS_PER_WAVE = 100;

class CreateWaveDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(MAX_ORDERS_PER_WAVE)
  @IsString({ each: true })
  pickingOrderIds!: string[];

  @ApiPropertyOptional({ description: 'Picker of the wave and its orders' }) @IsOptional() @IsString() assignedToId?: string;
}

class WavePickDto {
  @ApiProperty() @IsString() @IsNotEmpty() productId!: string;
  @ApiProperty({ minimum: 1 }) @IsInt() @IsPositive() quantity!: number;
  @ApiPropertyOptional() @IsOptional() @IsString() locationId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() lotId?: string;
}

class WaveQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: WaveStatus }) @IsOptional() @IsEnum(WaveStatus) status?: WaveStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() warehouseId?: string;
}

@ApiTags('waves')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('waves')
export class WavesController {
  constructor(private waves: WavesService) {}

  @Get()
  @ApiOperation({ summary: 'Olas de picking' })
  findAll(@Query() query: WaveQueryDto, @CurrentUser() user: AuthUser) {
    return this.waves.findAll({ ...query, warehouseId: scopeWarehouseFilter(user, query.warehouseId) });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle de la ola con sus órdenes y avance' })
  findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.waves.findById(id, user);
  }

  @Get(':id/pick-list')
  @ApiOperation({ summary: 'Lista consolidada por producto en orden de recorrido, con el reparto por orden' })
  pickList(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.waves.pickList(id, user);
  }

  @Post()
  @RequirePermissions('waves.manage')
  @ApiOperation({ summary: 'Agrupar órdenes pendientes o en curso del mismo almacén en una ola' })
  create(@Body() dto: CreateWaveDto, @CurrentUser() user: AuthUser) {
    return this.waves.create(dto, user);
  }

  @Post(':id/pick')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Registrar unidades recogidas de un producto; se reparten por prioridad y antigüedad' })
  pick(@Param('id') id: string, @Body() dto: WavePickDto, @CurrentUser() user: AuthUser) {
    return this.waves.pick(id, dto, user);
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Completar la ola: completa las órdenes con unidades recogidas y libera las demás' })
  complete(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.waves.complete(id, user);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('waves.manage')
  @ApiOperation({ summary: 'Deshacer la ola; las órdenes conservan su avance' })
  cancel(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.waves.cancel(id, user);
  }
}
