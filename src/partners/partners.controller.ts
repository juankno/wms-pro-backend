import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { CreatePartnerDto, PartnerQueryDto, UpdatePartnerDto } from './dto/partner.dto';
import { PartnersService } from './partners.service';

@ApiTags('partners')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('partners')
export class PartnersController {
  constructor(private partners: PartnersService) {}

  @Get()
  @ApiOperation({ summary: 'Clientes y proveedores', description: 'Filtra por `kind` (customer, supplier) y texto.' })
  findAll(@Query() query: PartnerQueryDto) {
    return this.partners.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle de un cliente o proveedor' })
  findOne(@Param('id') id: string) {
    return this.partners.findById(id);
  }

  @Post()
  @RequirePermissions('partners.manage')
  @ApiOperation({ summary: 'Crear cliente o proveedor' })
  create(@Body() dto: CreatePartnerDto) {
    return this.partners.create(dto);
  }

  @Patch(':id')
  @RequirePermissions('partners.manage')
  @ApiOperation({ summary: 'Editar o desactivar cliente o proveedor' })
  update(@Param('id') id: string, @Body() dto: UpdatePartnerDto) {
    return this.partners.update(id, dto);
  }
}
