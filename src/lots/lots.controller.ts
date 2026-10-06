import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PaginationDto } from '../common/dto/pagination.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/request-with-user.interface';
import { scopeWarehouseFilter } from '../common/utils/warehouse-scope';
import { LotsService } from './lots.service';

class LotQueryDto extends PaginationDto {
  @ApiPropertyOptional() @IsOptional() @IsString() productId?: string;
  @ApiPropertyOptional({ description: "Defaults to the user's warehouse unless they can see all" })
  @IsOptional()
  @IsString()
  warehouseId?: string;

  @ApiPropertyOptional({ description: 'Lot code contains' }) @IsOptional() @IsString() search?: string;

  @ApiPropertyOptional({ description: 'Only lots expiring within this many days (expired included)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3650)
  expiringWithinDays?: number;
}

@ApiTags('lots')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('lots')
export class LotsController {
  constructor(private lots: LotsService) {}

  @Get()
  @ApiOperation({ summary: 'Lotes con stock, ordenados por vencimiento' })
  findAll(@Query() query: LotQueryDto, @CurrentUser() user: AuthUser) {
    return this.lots.findAll({ ...query, warehouseId: scopeWarehouseFilter(user, query.warehouseId) });
  }

  @Get(':id/trace')
  @ApiOperation({ summary: 'Trazabilidad del lote: stock, movimientos y órdenes que lo despacharon' })
  trace(@Param('id') id: string, @Query('warehouseId') warehouseId: string | undefined, @CurrentUser() user: AuthUser) {
    return this.lots.trace(id, scopeWarehouseFilter(user, warehouseId));
  }
}
