import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { WarehousesService } from './warehouses.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

const WAREHOUSE_EXAMPLE = {
  id: '4f749c36-91a8-4e0f-928f-d8915c2ba8ec',
  name: 'Bodega Principal Bogotá',
  code: 'BOG-01',
  address: 'Cra 30 # 45-60, Bogotá',
  active: true,
  createdAt: '2025-01-10T08:00:00.000Z',
  updatedAt: '2025-01-10T08:00:00.000Z',
};

@ApiTags('warehouses')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('warehouses')
export class WarehousesController {
  constructor(private warehousesService: WarehousesService) {}

  @Get()
  @ApiOperation({ summary: 'Listar almacenes', description: 'Devuelve todos los almacenes activos.' })
  @ApiResponse({ status: 200, description: 'Lista de almacenes', schema: { example: [WAREHOUSE_EXAMPLE] } })
  findAll() {
    return this.warehousesService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener almacén', description: 'Devuelve el detalle de un almacén por ID.' })
  @ApiParam({ name: 'id', example: '4f749c36-91a8-4e0f-928f-d8915c2ba8ec' })
  @ApiResponse({ status: 200, description: 'Almacén encontrado', schema: { example: WAREHOUSE_EXAMPLE } })
  @ApiResponse({ status: 404, description: 'No encontrado', schema: { example: { error: 'WAREHOUSE_NOT_FOUND', message: 'Almacén no encontrado' } } })
  findOne(@Param('id') id: string) {
    return this.warehousesService.findById(id);
  }

  @Post()
  @Roles(Role.admin)
  @ApiOperation({ summary: 'Crear almacén', description: 'Crea un nuevo almacén. **Requiere rol admin.**' })
  @ApiResponse({ status: 201, description: 'Almacén creado', schema: { example: WAREHOUSE_EXAMPLE } })
  @ApiResponse({ status: 403, description: 'Rol insuficiente', schema: { example: { error: 'AUTH_UNAUTHORIZED', message: 'Acceso denegado' } } })
  @ApiResponse({ status: 422, description: 'Datos inválidos', schema: { example: { error: 'VALIDATION_ERROR', message: 'Datos de entrada inválidos', details: [{ field: 'code', message: 'El código es requerido' }] } } })
  create(@Body() body: { name: string; code: string; address?: string }) {
    return this.warehousesService.create(body);
  }

  @Patch(':id')
  @Roles(Role.admin)
  @ApiOperation({ summary: 'Editar almacén', description: 'Actualiza nombre, dirección o estado activo. **Requiere rol admin.**' })
  @ApiParam({ name: 'id', example: '4f749c36-91a8-4e0f-928f-d8915c2ba8ec' })
  @ApiResponse({ status: 200, description: 'Almacén actualizado', schema: { example: WAREHOUSE_EXAMPLE } })
  @ApiResponse({ status: 404, description: 'No encontrado', schema: { example: { error: 'WAREHOUSE_NOT_FOUND', message: 'Almacén no encontrado' } } })
  update(@Param('id') id: string, @Body() body: { name?: string; address?: string; active?: boolean }) {
    return this.warehousesService.update(id, body);
  }
}
