import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/request-with-user.interface';
import { assertWarehouseAccess } from '../common/utils/warehouse-scope';
import { CreateLocationDto, GenerateLocationsDto, LocationQueryDto, UpdateLocationDto } from './dto/location.dto';
import { LocationsService } from './locations.service';

@ApiTags('locations')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('locations')
export class LocationsController {
  constructor(private locations: LocationsService) {}

  @Get()
  @ApiOperation({ summary: 'Ubicaciones de un almacén', description: 'Filtra por padre (`root` para el primer nivel), tipo o texto.' })
  findAll(@Query() query: LocationQueryDto, @CurrentUser() user: AuthUser) {
    assertWarehouseAccess(user, query.warehouseId);
    return this.locations.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle de una ubicación con su ruta desde la raíz' })
  findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.locations.findById(id, user);
  }

  @Post()
  @RequirePermissions('locations.manage')
  @ApiOperation({ summary: 'Crear ubicación' })
  create(@Body() dto: CreateLocationDto, @CurrentUser() user: AuthUser) {
    return this.locations.create(dto, user);
  }

  @Post('generate')
  @RequirePermissions('locations.manage')
  @ApiOperation({
    summary: 'Generar ubicaciones por niveles',
    description: 'Ej.: pasillos A–C × estanterías 01–10 × niveles 1–4. Los códigos existentes se conservan.',
  })
  generate(@Body() dto: GenerateLocationsDto, @CurrentUser() user: AuthUser) {
    return this.locations.generate(dto, user);
  }

  @Patch(':id')
  @RequirePermissions('locations.manage')
  @ApiOperation({ summary: 'Editar o mover una ubicación' })
  update(@Param('id') id: string, @Body() dto: UpdateLocationDto, @CurrentUser() user: AuthUser) {
    return this.locations.update(id, dto, user);
  }

  @Delete(':id')
  @RequirePermissions('locations.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Eliminar una ubicación sin ubicaciones internas' })
  async remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.locations.delete(id, user);
  }
}
