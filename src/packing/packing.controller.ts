import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { OrderStatus, Role } from '@prisma/client';
import { PackingService } from './packing.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/request-with-user.interface';
import { PaginationDto } from '../common/dto/pagination.dto';

const PACKING_ITEM_EXAMPLE = {
  id: 'pki_001',
  packingOrderId: 'pack_001',
  productId: 'p001',
  productCode: 'FLT-0001',
  productName: 'Filtro de Aceite CAT 1R-0716',
  barcode: '7891234560001',
  unit: 'UND',
  quantity: 10,
  packedQuantity: 10,
};

const BOX_EXAMPLE = {
  id: 'box_001',
  packingOrderId: 'pack_001',
  label: 'Caja 1 de 2',
  sealed: false,
  createdAt: '2025-06-02T08:30:00.000Z',
};

const PACKING_EXAMPLE = {
  id: 'pack_001',
  reference: 'PACK-2025-001',
  client: 'Constructora Andina S.A.S.',
  status: 'in_progress',
  pickingOrderId: 'pick_001',
  warehouseId: '4f749c36-91a8-4e0f-928f-d8915c2ba8ec',
  assignedToId: 'user_002',
  assignedTo: { id: 'user_002', name: 'María Operaria' },
  notes: null,
  totalWeight: null,
  completedAt: null,
  cancelledAt: null,
  createdById: 'user_001',
  createdAt: '2025-06-02T08:00:00.000Z',
  updatedAt: '2025-06-02T09:15:00.000Z',
  items: [PACKING_ITEM_EXAMPLE],
  boxes: [BOX_EXAMPLE],
};

const ERR_401 = { error: 'AUTH_TOKEN_EXPIRED', message: 'Token inválido o expirado', requestId: 'req_abc123' };
const ERR_403 = { error: 'AUTH_UNAUTHORIZED', message: 'Acceso denegado', requestId: 'req_abc123' };
const ERR_404 = { error: 'ORDER_NOT_FOUND', message: 'Orden de packing no encontrada', requestId: 'req_abc123' };
const ERR_422_STATUS = { error: 'ORDER_INVALID_STATUS', message: 'Transición de estado inválida: completed → in_progress', requestId: 'req_abc123' };
const ERR_422_PICKING = { error: 'PICKING_INCOMPLETE', message: 'El picking debe estar completado para crear el packing', requestId: 'req_abc123' };
const ERR_422_VAL = { error: 'VALIDATION_ERROR', message: 'Datos de entrada inválidos', details: [{ field: 'reference', message: 'must not be empty' }], requestId: 'req_abc123' };
const ERR_409_PICKING = { error: 'ORDER_INVALID_STATUS', message: 'Ya existe un packing para este picking', requestId: 'req_abc123' };

@ApiTags('packing')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('packing')
export class PackingController {
  constructor(private packingService: PackingService) {}

  @Get()
  @ApiOperation({
    summary: 'Listar órdenes de packing',
    description: `Devuelve las órdenes de packing paginadas. Los admins ven todas.

**Flujo de packing:**
1. El picking debe estar \`completed\`
2. Crear packing con \`POST /packing\` — copia los ítems del picking
3. Cambiar a \`in_progress\` y agregar cajas según se empaca
4. Cambiar a \`completed\` → **descuenta el stock físico de forma atómica**

**Ejemplo de llamada:**
\`\`\`http
GET /v1/packing?status=in_progress&page=1&limit=20
Authorization: Bearer eyJ...
\`\`\``,
  })
  @ApiQuery({ name: 'status', required: false, enum: OrderStatus, description: 'Filtrar por estado' })
  @ApiQuery({ name: 'assignedTo', required: false, description: 'ID del operario asignado' })
  @ApiQuery({ name: 'search', required: false, description: 'Busca en referencia, cliente, picking' })
  @ApiQuery({ name: 'from', required: false, description: 'Fecha inicio ISO 8601', example: '2025-06-01' })
  @ApiQuery({ name: 'to', required: false, description: 'Fecha fin ISO 8601', example: '2025-06-30' })
  @ApiQuery({ name: 'warehouseId', required: false, description: 'Almacén (solo admin)' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiResponse({
    status: 200,
    description: 'Lista paginada de órdenes',
    schema: { example: { data: [{ ...PACKING_EXAMPLE, items: undefined, boxes: undefined }], meta: { total: 30, page: 1, limit: 20, totalPages: 2 } } },
  })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  findAll(
    @Query() q: PaginationDto & { status?: OrderStatus; assignedTo?: string; search?: string; from?: string; to?: string; warehouseId?: string },
    @CurrentUser() user: AuthUser,
  ) {
    return this.packingService.findAll({
      warehouseId: q.warehouseId ?? user.warehouseId,
      role: user.role,
      status: q.status,
      assignedTo: q.assignedTo,
      search: q.search,
      from: q.from,
      to: q.to,
      page: q.page,
      limit: q.limit,
    });
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Detalle de orden de packing',
    description: 'Devuelve la orden completa con ítems, cajas y datos del picking origen.',
  })
  @ApiParam({ name: 'id', description: 'ID de la orden', example: 'pack_001' })
  @ApiResponse({ status: 200, description: 'Orden encontrada', schema: { example: PACKING_EXAMPLE } })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  @ApiResponse({ status: 404, description: 'Orden no encontrada', schema: { example: ERR_404 } })
  findOne(@Param('id') id: string) {
    return this.packingService.findById(id);
  }

  @Post()
  @ApiOperation({
    summary: 'Crear orden de packing',
    description: `Crea una orden de packing a partir de un picking **completado**. Copia automáticamente todos los ítems del picking con sus cantidades recogidas.

**Prerequisito:** el picking referenciado debe estar en estado \`completed\`.

**Ejemplo de llamada:**
\`\`\`http
POST /v1/packing
Authorization: Bearer eyJ...
Content-Type: application/json

{
  "pickingOrderId": "pick_001",
  "reference": "PACK-2025-001",
  "assignedToId": "user_002",
  "notes": "Frágil"
}
\`\`\``,
  })
  @ApiBody({
    schema: {
      example: {
        pickingOrderId: 'pick_001',
        reference: 'PACK-2025-001',
        assignedToId: 'user_002',
        notes: 'Frágil',
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Orden creada en estado `pending`', schema: { example: PACKING_EXAMPLE } })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  @ApiResponse({ status: 404, description: 'Picking no encontrado', schema: { example: { ...ERR_404, message: 'Orden de picking no encontrada' } } })
  @ApiResponse({ status: 409, description: 'Ya existe packing para este picking', schema: { example: ERR_409_PICKING } })
  @ApiResponse({ status: 422, description: 'Picking no está completado', schema: { example: ERR_422_PICKING } })
  create(
    @Body() body: { pickingOrderId: string; reference: string; assignedToId?: string; notes?: string },
    @CurrentUser() user: AuthUser,
  ) {
    return this.packingService.create({ ...body, createdById: user.id });
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Editar datos de la orden',
    description: 'Actualiza notas, asignación o peso total. **No cambia el estado** — usar `PATCH /:id/status`.',
  })
  @ApiParam({ name: 'id', description: 'ID de la orden', example: 'pack_001' })
  @ApiResponse({ status: 200, description: 'Orden actualizada', schema: { example: PACKING_EXAMPLE } })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  @ApiResponse({ status: 404, description: 'Orden no encontrada', schema: { example: ERR_404 } })
  update(@Param('id') id: string, @Body() body: { notes?: string; assignedToId?: string; totalWeight?: number }) {
    return this.packingService.update(id, body);
  }

  @Delete(':id')
  @Roles(Role.supervisor)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Eliminar orden de packing',
    description: 'Elimina la orden. **Solo se pueden eliminar órdenes en estado `pending`.** **Requiere rol supervisor o admin.**',
  })
  @ApiParam({ name: 'id', description: 'ID de la orden', example: 'pack_001' })
  @ApiResponse({ status: 204, description: 'Orden eliminada' })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  @ApiResponse({ status: 403, description: 'Rol insuficiente', schema: { example: ERR_403 } })
  @ApiResponse({ status: 404, description: 'Orden no encontrada', schema: { example: ERR_404 } })
  @ApiResponse({ status: 422, description: 'La orden no está en estado pending', schema: { example: { ...ERR_422_STATUS, message: 'Solo se pueden eliminar órdenes pending' } } })
  remove(@Param('id') id: string) {
    return this.packingService.delete(id);
  }

  @Patch(':id/status')
  @ApiOperation({
    summary: 'Cambiar estado de la orden',
    description: `Avanza o cancela el packing.

**Transiciones válidas:**
- \`pending\` → \`in_progress\`
- \`in_progress\` → \`completed\` — **descuenta el stock físico de forma atómica** y genera movimientos \`salida_picking\`
- \`pending\` / \`in_progress\` → \`cancelled\`

**Ejemplo de llamada:**
\`\`\`http
PATCH /v1/packing/pack_001/status
Authorization: Bearer eyJ...
Content-Type: application/json

{ "status": "completed" }
\`\`\``,
  })
  @ApiParam({ name: 'id', description: 'ID de la orden', example: 'pack_001' })
  @ApiBody({ schema: { example: { status: 'completed' } } })
  @ApiResponse({ status: 200, description: 'Estado actualizado', schema: { example: { ...PACKING_EXAMPLE, status: 'completed', completedAt: '2025-06-02T10:00:00.000Z' } } })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  @ApiResponse({ status: 404, description: 'Orden no encontrada', schema: { example: ERR_404 } })
  @ApiResponse({ status: 422, description: 'Transición de estado inválida', schema: { example: ERR_422_STATUS } })
  updateStatus(
    @Param('id') id: string,
    @Body() body: { status: OrderStatus },
    @CurrentUser() user: AuthUser,
  ) {
    return this.packingService.updateStatus(id, body.status, user.id, user.name);
  }

  @Patch(':id/items/:itemId')
  @ApiOperation({
    summary: 'Actualizar cantidad empacada de un ítem',
    description: 'Registra cuántas unidades de un ítem se han empacado. `packedQuantity` no puede superar `quantity`.',
  })
  @ApiParam({ name: 'id', description: 'ID de la orden', example: 'pack_001' })
  @ApiParam({ name: 'itemId', description: 'ID del ítem', example: 'pki_001' })
  @ApiBody({ schema: { example: { packedQuantity: 10 } } })
  @ApiResponse({ status: 200, description: 'Ítem actualizado', schema: { example: PACKING_ITEM_EXAMPLE } })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  @ApiResponse({ status: 404, description: 'Orden o ítem no encontrado', schema: { example: ERR_404 } })
  updateItem(
    @Param('id') orderId: string,
    @Param('itemId') itemId: string,
    @Body() body: { packedQuantity: number },
  ) {
    return this.packingService.updateItem(orderId, itemId, body.packedQuantity);
  }

  @Post(':id/boxes')
  @ApiOperation({
    summary: 'Agregar caja al packing',
    description: `Agrega una nueva caja a la orden de packing. Las cajas se usan para organizar los ítems antes del sellado.

**Ejemplo de llamada:**
\`\`\`http
POST /v1/packing/pack_001/boxes
Authorization: Bearer eyJ...
Content-Type: application/json

{ "label": "Caja 1 de 2" }
\`\`\``,
  })
  @ApiParam({ name: 'id', description: 'ID de la orden', example: 'pack_001' })
  @ApiBody({ schema: { example: { label: 'Caja 1 de 2' } } })
  @ApiResponse({ status: 201, description: 'Caja creada', schema: { example: BOX_EXAMPLE } })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  @ApiResponse({ status: 404, description: 'Orden no encontrada', schema: { example: ERR_404 } })
  addBox(@Param('id') id: string, @Body() body: { label: string }) {
    return this.packingService.addBox(id, body.label);
  }

  @Post(':id/photos')
  @ApiOperation({
    summary: 'Agregar foto al packing',
    description: 'Asocia una URL de foto (obtenida de `POST /uploads/photo`) a la orden de packing.',
  })
  @ApiParam({ name: 'id', description: 'ID de la orden', example: 'pack_001' })
  @ApiBody({ schema: { example: { url: 'https://api.example.com/uploads/foto.jpg' } } })
  @ApiResponse({ status: 201, description: 'Foto añadida' })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  @ApiResponse({ status: 404, description: 'Orden no encontrada', schema: { example: ERR_404 } })
  addPhoto(@Param('id') id: string, @Body('url') url: string, @CurrentUser() user: AuthUser) {
    return this.packingService.addPhoto(id, url, user);
  }

  @Delete(':id/photos/:photoUrl')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Eliminar foto del packing',
    description: 'Elimina una foto de la lista. `photoUrl` debe estar URL-encoded.',
  })
  @ApiParam({ name: 'id', description: 'ID de la orden', example: 'pack_001' })
  @ApiParam({ name: 'photoUrl', description: 'URL de la foto (URL-encoded)', example: 'https%3A%2F%2Fapi.example.com%2Fuploads%2Ffoto.jpg' })
  @ApiResponse({ status: 204, description: 'Foto eliminada' })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  @ApiResponse({ status: 404, description: 'Orden no encontrada', schema: { example: ERR_404 } })
  removePhoto(@Param('id') id: string, @Param('photoUrl') photoUrl: string, @CurrentUser() user: AuthUser) {
    return this.packingService.removePhoto(id, decodeURIComponent(photoUrl), user);
  }

  @Patch(':id/boxes/:boxId/seal')
  @ApiOperation({
    summary: 'Sellar caja',
    description: 'Marca la caja como sellada (`sealed: true`). Una vez sellada no puede volver a abrirse.',
  })
  @ApiParam({ name: 'id', description: 'ID de la orden', example: 'pack_001' })
  @ApiParam({ name: 'boxId', description: 'ID de la caja', example: 'box_001' })
  @ApiResponse({ status: 200, description: 'Caja sellada', schema: { example: { ...BOX_EXAMPLE, sealed: true } } })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  @ApiResponse({ status: 404, description: 'Orden o caja no encontrada', schema: { example: ERR_404 } })
  sealBox(@Param('id') id: string, @Param('boxId') boxId: string) {
    return this.packingService.sealBox(id, boxId);
  }
}
