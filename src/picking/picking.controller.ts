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
import { OrderStatus, Priority } from '@prisma/client';
import { PickingService } from './picking.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/request-with-user.interface';
import { PickingQueryDto } from '../common/dto/orders-query.dto';
import { resolveWarehouseId, scopeWarehouseFilter } from '../common/utils/warehouse-scope';
import {
  AddPhotoDto,
  CreatePickingDto,
  UpdatePickingDto,
  UpdatePickingItemDto,
  UpdatePickingStatusDto,
} from './dto/create-picking.dto';
import { RequirePermissions } from '../auth/permissions.decorator';

const PICKING_ITEM_EXAMPLE = {
  id: 'pi_001',
  pickingOrderId: 'pick_001',
  productId: 'p001',
  productCode: 'FLT-0001',
  productName: 'Filtro de Aceite CAT 1R-0716',
  barcode: '7891234560001',
  unit: 'UND',
  quantity: 10,
  pickedQuantity: 7,
  location: 'A-01-03',
};

const PICKING_EXAMPLE = {
  id: 'pick_001',
  reference: 'PICK-2025-001',
  client: 'Constructora Andina S.A.S.',
  status: 'in_progress',
  priority: 'high',
  warehouseId: '4f749c36-91a8-4e0f-928f-d8915c2ba8ec',
  assignedToId: 'user_002',
  assignedTo: { id: 'user_002', name: 'María Operaria' },
  notes: 'Urgente para entrega mañana',
  completedAt: null,
  cancelledAt: null,
  createdById: 'user_001',
  createdAt: '2025-06-01T09:00:00.000Z',
  updatedAt: '2025-06-01T10:30:00.000Z',
  items: [PICKING_ITEM_EXAMPLE],
};

const ERR_401 = { error: 'AUTH_TOKEN_EXPIRED', message: 'Token inválido o expirado', requestId: 'req_abc123' };
const ERR_403 = { error: 'AUTH_UNAUTHORIZED', message: 'Acceso denegado', requestId: 'req_abc123' };
const ERR_404 = { error: 'ORDER_NOT_FOUND', message: 'Orden de picking no encontrada', requestId: 'req_abc123' };
const ERR_409_STOCK = { error: 'INSUFFICIENT_STOCK', message: 'Stock disponible insuficiente para el producto FLT-0001 (disponible: 3, requerido: 10)', requestId: 'req_abc123' };
const ERR_422_STATUS = { error: 'ORDER_INVALID_STATUS', message: 'Transición de estado inválida: completed → in_progress', requestId: 'req_abc123' };
const ERR_422_VAL = { error: 'VALIDATION_ERROR', message: 'Datos de entrada inválidos', details: [{ field: 'reference', message: 'must not be empty' }], requestId: 'req_abc123' };

@ApiTags('picking')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('picking')
export class PickingController {
  constructor(private pickingService: PickingService) {}

  @Get()
  @ApiOperation({
    summary: 'Listar órdenes de picking',
    description: `Devuelve las órdenes de picking paginadas del almacén del usuario. Los admins ven todas.

**Transiciones de estado válidas:**
\`\`\`
pending → in_progress → completed
pending → cancelled
in_progress → cancelled  (libera las reservas de stock)
\`\`\`

**Ejemplo de llamada:**
\`\`\`http
GET /v1/picking?status=in_progress&page=1&limit=20
Authorization: Bearer eyJ...
\`\`\``,
  })
  @ApiQuery({ name: 'status', required: false, enum: OrderStatus, description: 'Filtrar por estado' })
  @ApiQuery({ name: 'assignedTo', required: false, description: 'ID del operario asignado', example: 'user_002' })
  @ApiQuery({ name: 'search', required: false, description: 'Busca en referencia y cliente', example: 'Constructora' })
  @ApiQuery({ name: 'priority', required: false, enum: Priority, description: 'Filtrar por prioridad' })
  @ApiQuery({ name: 'dateFrom', required: false, description: 'Fecha inicio ISO 8601', example: '2025-06-01' })
  @ApiQuery({ name: 'dateTo', required: false, description: 'Fecha fin ISO 8601', example: '2025-06-30' })
  @ApiQuery({ name: 'warehouseId', required: false, description: 'Almacén (solo admin, default: almacén del usuario)' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiResponse({
    status: 200,
    description: 'Lista paginada de órdenes',
    schema: { example: { data: [{ ...PICKING_EXAMPLE, items: undefined }], meta: { total: 45, page: 1, limit: 20, totalPages: 3 } } },
  })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  findAll(
    @Query() q: PickingQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.pickingService.findAll({
      warehouseId: scopeWarehouseFilter(user, q.warehouseId),
      status: q.status,
      priority: q.priority,
      assignedTo: q.assignedTo,
      search: q.search,
      dateFrom: q.dateFrom,
      dateTo: q.dateTo,
      page: q.page,
      limit: q.limit,
    });
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Detalle de orden de picking',
    description: 'Devuelve la orden completa con todos sus ítems y cantidades recogidas.',
  })
  @ApiParam({ name: 'id', description: 'ID de la orden', example: 'pick_001' })
  @ApiResponse({ status: 200, description: 'Orden encontrada', schema: { example: PICKING_EXAMPLE } })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  @ApiResponse({ status: 404, description: 'Orden no encontrada', schema: { example: ERR_404 } })
  findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.pickingService.findById(id, user);
  }

  @Post()
  @ApiOperation({
    summary: 'Crear orden de picking',
    description: `Crea una nueva orden de picking validando que haya stock disponible para todos los ítems.

Si algún producto no tiene suficiente stock disponible devuelve \`409 INSUFFICIENT_STOCK\` antes de crear nada.

**Ejemplo de llamada:**
\`\`\`http
POST /v1/picking
Authorization: Bearer eyJ...
Content-Type: application/json

{
  "reference": "PICK-2025-001",
  "client": "Constructora Andina S.A.S.",
  "priority": "high",
  "assignedToId": "user_002",
  "notes": "Urgente para entrega mañana",
  "items": [
    { "productId": "p001", "quantity": 10 },
    { "productId": "p002", "quantity": 5 }
  ]
}
\`\`\``,
  })
  @ApiBody({
    schema: {
      example: {
        reference: 'PICK-2025-001',
        client: 'Constructora Andina S.A.S.',
        priority: 'high',
        assignedToId: 'user_002',
        notes: 'Urgente para entrega mañana',
        items: [
          { productId: 'p001', quantity: 10 },
          { productId: 'p002', quantity: 5 },
        ],
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Orden creada en estado `pending`', schema: { example: PICKING_EXAMPLE } })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  @ApiResponse({ status: 409, description: 'Stock insuficiente', schema: { example: ERR_409_STOCK } })
  @ApiResponse({ status: 422, description: 'Datos inválidos', schema: { example: ERR_422_VAL } })
  create(
    @Body() body: CreatePickingDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.pickingService.create({ ...body, warehouseId: resolveWarehouseId(user, body.warehouseId) }, user);
  }

  @Post(':id/photos')
  @ApiOperation({
    summary: 'Agregar foto a la orden',
    description: 'Asocia una URL de foto (obtenida de `POST /uploads/photo`) a la orden.',
  })
  @ApiParam({ name: 'id', description: 'ID de la orden', example: 'pick_001' })
  @ApiBody({ schema: { example: { url: 'https://api.example.com/uploads/foto.jpg' } } })
  @ApiResponse({ status: 201, description: 'Foto añadida' })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  @ApiResponse({ status: 404, description: 'Orden no encontrada', schema: { example: ERR_404 } })
  addPhoto(@Param('id') id: string, @Body() body: AddPhotoDto, @CurrentUser() user: AuthUser) {
    return this.pickingService.addPhoto(id, body.url, user);
  }

  @Delete(':id/photos/:photoUrl')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Eliminar foto de la orden',
    description: 'Elimina una foto de la lista. `photoUrl` debe estar URL-encoded.',
  })
  @ApiParam({ name: 'id', description: 'ID de la orden', example: 'pick_001' })
  @ApiParam({ name: 'photoUrl', description: 'URL de la foto (URL-encoded)', example: 'https%3A%2F%2Fapi.example.com%2Fuploads%2Ffoto.jpg' })
  @ApiResponse({ status: 204, description: 'Foto eliminada' })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  @ApiResponse({ status: 404, description: 'Orden no encontrada', schema: { example: ERR_404 } })
  removePhoto(@Param('id') id: string, @Param('photoUrl') photoUrl: string, @CurrentUser() user: AuthUser) {
    return this.pickingService.removePhoto(id, decodeURIComponent(photoUrl), user);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Editar datos de la orden',
    description: 'Actualiza notas, prioridad o asignación. **No cambia el estado** — usar `PATCH /:id/status` para eso.',
  })
  @ApiParam({ name: 'id', description: 'ID de la orden', example: 'pick_001' })
  @ApiResponse({ status: 200, description: 'Orden actualizada', schema: { example: PICKING_EXAMPLE } })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  @ApiResponse({ status: 404, description: 'Orden no encontrada', schema: { example: ERR_404 } })
  update(@Param('id') id: string, @Body() body: UpdatePickingDto, @CurrentUser() user: AuthUser) {
    return this.pickingService.update(id, body, user);
  }

  @Delete(':id')
  @RequirePermissions('orders.delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Eliminar orden de picking',
    description: 'Elimina una orden de picking. **Solo se pueden eliminar órdenes en estado `pending`.** **Requiere rol supervisor o admin.**',
  })
  @ApiParam({ name: 'id', description: 'ID de la orden', example: 'pick_001' })
  @ApiResponse({ status: 204, description: 'Orden eliminada' })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  @ApiResponse({ status: 403, description: 'Rol insuficiente', schema: { example: ERR_403 } })
  @ApiResponse({ status: 404, description: 'Orden no encontrada', schema: { example: ERR_404 } })
  @ApiResponse({ status: 422, description: 'La orden no está en estado pending', schema: { example: { ...ERR_422_STATUS, message: 'Solo se pueden eliminar órdenes pending' } } })
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.pickingService.delete(id, user);
  }

  @Patch(':id/status')
  @ApiOperation({
    summary: 'Cambiar estado de la orden',
    description: `Avanza o cancela el estado de la orden.

**Transiciones válidas:**
- \`pending\` → \`in_progress\` — inicia el picking (no afecta stock)
- \`in_progress\` → \`completed\` — marca todos los ítems como listos
- \`pending\` / \`in_progress\` → \`cancelled\` — libera el stock reservado

**Ejemplo de llamada:**
\`\`\`http
PATCH /v1/picking/pick_001/status
Authorization: Bearer eyJ...
Content-Type: application/json

{ "status": "in_progress" }
\`\`\``,
  })
  @ApiParam({ name: 'id', description: 'ID de la orden', example: 'pick_001' })
  @ApiBody({ schema: { example: { status: 'in_progress' } } })
  @ApiResponse({ status: 200, description: 'Estado actualizado', schema: { example: { ...PICKING_EXAMPLE, status: 'in_progress' } } })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  @ApiResponse({ status: 404, description: 'Orden no encontrada', schema: { example: ERR_404 } })
  @ApiResponse({ status: 422, description: 'Transición de estado inválida', schema: { example: ERR_422_STATUS } })
  updateStatus(
    @Param('id') id: string,
    @Body() body: UpdatePickingStatusDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.pickingService.updateStatus(id, body.status, user);
  }

  @Patch(':id/items/:itemId')
  @ApiOperation({
    summary: 'Registrar cantidad recogida de un ítem',
    description: `Actualiza la cantidad recogida de un ítem. El sistema reserva el delta de stock en tiempo real.

- Si \`pickedQuantity\` **aumenta** → \`reserved += delta\`
- Si \`pickedQuantity\` **disminuye** → \`reserved -= delta\` (libera parcialmente)
- Si \`pickedQuantity > available\` → \`409 INSUFFICIENT_STOCK\`

**Ejemplo de llamada:**
\`\`\`http
PATCH /v1/picking/pick_001/items/pi_001
Authorization: Bearer eyJ...
Content-Type: application/json

{ "pickedQuantity": 7 }
\`\`\``,
  })
  @ApiParam({ name: 'id', description: 'ID de la orden', example: 'pick_001' })
  @ApiParam({ name: 'itemId', description: 'ID del ítem', example: 'pi_001' })
  @ApiBody({ schema: { example: { pickedQuantity: 7 } } })
  @ApiResponse({ status: 200, description: 'Ítem actualizado', schema: { example: { ...PICKING_ITEM_EXAMPLE, pickedQuantity: 7 } } })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  @ApiResponse({ status: 404, description: 'Orden o ítem no encontrado', schema: { example: ERR_404 } })
  @ApiResponse({ status: 409, description: 'Stock insuficiente', schema: { example: ERR_409_STOCK } })
  updateItem(
    @Param('id') orderId: string,
    @Param('itemId') itemId: string,
    @Body() body: UpdatePickingItemDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.pickingService.updateItem(orderId, itemId, body.pickedQuantity, user);
  }
}
