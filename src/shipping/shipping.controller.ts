import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { ShipmentStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsEnum, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { PaginationDto } from '../common/dto/pagination.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/request-with-user.interface';
import { scopeWarehouseFilter } from '../common/utils/warehouse-scope';
import { ShippingService } from './shipping.service';

const TRACKING_TEMPLATE = /^https?:\/\/\S*\{tracking\}\S*$/;
const TEMPLATE_MESSAGE = 'Debe ser una URL http(s) que contenga {tracking}';

class CreateCarrierDto {
  @ApiProperty({ example: 'Servientrega' }) @IsString() @IsNotEmpty() @MaxLength(100) name!: string;

  @ApiPropertyOptional({ example: 'https://rastreo.ejemplo.com/guia/{tracking}' })
  @IsOptional()
  @Matches(TRACKING_TEMPLATE, { message: TEMPLATE_MESSAGE })
  trackingUrlTemplate?: string;
}

class UpdateCarrierDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100) name?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(TRACKING_TEMPLATE, { message: TEMPLATE_MESSAGE })
  trackingUrlTemplate?: string | null;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() active?: boolean;
}

class ShipDto {
  @ApiPropertyOptional() @IsOptional() @IsString() carrierId?: string;
  @ApiPropertyOptional({ description: 'Free text when the carrier is not registered' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  carrierName?: string;

  @ApiPropertyOptional({ description: 'Guía' }) @IsOptional() @IsString() @MaxLength(100) trackingNumber?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

class DeliverDto {
  @ApiProperty({ description: 'Who received the goods' }) @IsString() @IsNotEmpty() @MaxLength(200) receivedBy!: string;
  @ApiPropertyOptional({ description: 'Photo or signature uploaded with POST /uploads/photo' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  proofPhotoUrl?: string;

  @ApiPropertyOptional({ description: 'Defaults to now' }) @IsOptional() @IsDateString() deliveredAt?: string;
}

class ShipmentQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: ShipmentStatus }) @IsOptional() @IsEnum(ShipmentStatus) status?: ShipmentStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() carrierId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() warehouseId?: string;
  @ApiPropertyOptional({ description: 'Tracking number, packing reference or client contains' })
  @IsOptional()
  @IsString()
  search?: string;
}

class CarrierQueryDto {
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeInactive?: boolean;
}

@ApiTags('shipping')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller()
export class ShippingController {
  constructor(private shipping: ShippingService) {}

  @Get('carriers')
  @ApiOperation({ summary: 'Transportadoras' })
  carriers(@Query() query: CarrierQueryDto) {
    return this.shipping.carriers(query.includeInactive);
  }

  @Post('carriers')
  @RequirePermissions('shipping.manage')
  @ApiOperation({ summary: 'Crear transportadora con su enlace de rastreo' })
  createCarrier(@Body() dto: CreateCarrierDto) {
    return this.shipping.createCarrier(dto);
  }

  @Patch('carriers/:id')
  @RequirePermissions('shipping.manage')
  @ApiOperation({ summary: 'Editar o desactivar transportadora' })
  updateCarrier(@Param('id') id: string, @Body() dto: UpdateCarrierDto) {
    return this.shipping.updateCarrier(id, dto);
  }

  @Get('shipments')
  @ApiOperation({ summary: 'Despachos con su guía y enlace de rastreo' })
  findAll(@Query() query: ShipmentQueryDto, @CurrentUser() user: AuthUser) {
    return this.shipping.findAll({ ...query, warehouseId: scopeWarehouseFilter(user, query.warehouseId) });
  }

  @Get('shipments/:id')
  @ApiOperation({ summary: 'Detalle del despacho' })
  findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.shipping.findById(id, user);
  }

  @Post('packing/:id/ship')
  @RequirePermissions('shipping.manage')
  @ApiOperation({ summary: 'Despachar un packing completado con transportadora y guía' })
  ship(@Param('id') id: string, @Body() dto: ShipDto, @CurrentUser() user: AuthUser) {
    return this.shipping.ship(id, dto, user);
  }

  @Post('shipments/:id/deliver')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('shipping.manage')
  @ApiOperation({ summary: 'Registrar la entrega con quién recibió y foto o firma' })
  deliver(@Param('id') id: string, @Body() dto: DeliverDto, @CurrentUser() user: AuthUser) {
    return this.shipping.deliver(id, dto, user);
  }
}
