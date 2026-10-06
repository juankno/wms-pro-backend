import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { StockTransferStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { PaginationDto } from '../common/dto/pagination.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/request-with-user.interface';
import { scopeWarehouseFilter } from '../common/utils/warehouse-scope';
import { StockTransfersService } from './stock-transfers.service';

class TransferItemDto {
  @ApiProperty() @IsString() @IsNotEmpty() productId!: string;
  @ApiProperty({ minimum: 1 }) @IsInt() @IsPositive() quantity!: number;
  @ApiPropertyOptional({ description: 'Omitted: locations in pick sequence' }) @IsOptional() @IsString() fromLocationId?: string;
  @ApiPropertyOptional({ description: 'Omitted: the product picking strategy' }) @IsOptional() @IsString() lotId?: string;
}

class SendTransferDto {
  @ApiProperty() @IsString() @IsNotEmpty() fromWarehouseId!: string;
  @ApiProperty() @IsString() @IsNotEmpty() toWarehouseId!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;

  @ApiProperty({ type: [TransferItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => TransferItemDto)
  items!: TransferItemDto[];
}

class ReceiveItemDto {
  @ApiProperty() @IsString() @IsNotEmpty() itemId!: string;
  @ApiProperty({ minimum: 0 }) @IsInt() @Min(0) receivedQuantity!: number;
  @ApiPropertyOptional() @IsOptional() @IsString() locationId?: string;
}

class ReceiveTransferDto {
  @ApiPropertyOptional({ type: [ReceiveItemDto], description: 'Omitted items are received in full' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReceiveItemDto)
  items?: ReceiveItemDto[];
}

class TransferQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: StockTransferStatus }) @IsOptional() @IsEnum(StockTransferStatus) status?: StockTransferStatus;
  @ApiPropertyOptional({ description: 'Origin or destination' }) @IsOptional() @IsString() warehouseId?: string;
}

@ApiTags('transfers')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('stock.transfer')
@Controller('transfers')
export class StockTransfersController {
  constructor(private transfers: StockTransfersService) {}

  @Get()
  @ApiOperation({ summary: 'Traslados entre almacenes (en tránsito o recibidos)' })
  findAll(@Query() query: TransferQueryDto, @CurrentUser() user: AuthUser) {
    return this.transfers.findAll({ ...query, warehouseId: scopeWarehouseFilter(user, query.warehouseId) });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle con lo enviado y lo recibido' })
  findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.transfers.findById(id, user);
  }

  @Post()
  @ApiOperation({ summary: 'Enviar: el stock sale del origen y queda en tránsito' })
  send(@Body() dto: SendTransferDto, @CurrentUser() user: AuthUser) {
    return this.transfers.send(dto, user);
  }

  @Post(':id/receive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Recibir en el destino con ubicación y diferencias' })
  receive(@Param('id') id: string, @Body() dto: ReceiveTransferDto, @CurrentUser() user: AuthUser) {
    return this.transfers.receive(id, dto, user);
  }
}
