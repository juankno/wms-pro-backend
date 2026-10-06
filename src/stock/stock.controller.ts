import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { MovementType } from '@prisma/client';
import { StockService } from './stock.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/request-with-user.interface';
import { assertWarehouseAccess, resolveWarehouseId, scopeWarehouseFilter } from '../common/utils/warehouse-scope';
import { CreateMovementDto, MovementsQueryDto, TransferDto, UpdateStockSettingsDto } from './dto/create-movement.dto';

const MOVEMENT_EXAMPLE = {
  id: 'mov_001',
  productId: 'p001',
  productCode: 'FLT-0001',
  productName: 'Filtro de Aceite CAT 1R-0716',
  warehouseId: '4f749c36-91a8-4e0f-928f-d8915c2ba8ec',
  warehouseName: 'Bogotá',
  type: 'purchase_receipt',
  quantity: 50,
  onHandBefore: 0,
  onHandAfter: 50,
  reservedBefore: 0,
  reservedAfter: 0,
  referenceType: 'manual',
  referenceId: null,
  notes: 'Ingreso inicial',
  operatorId: 'user_001',
  operatorName: 'Juan Supervisor',
  createdAt: '2025-06-01T10:00:00.000Z',
};

const ERR_401 = { error: 'AUTH_TOKEN_EXPIRED', message: 'Token inválido o expirado', requestId: 'req_abc123' };
const ERR_403 = { error: 'WAREHOUSE_FORBIDDEN', message: 'No tienes acceso a este almacén', requestId: 'req_abc123' };
const ERR_404_PRODUCT = { error: 'PRODUCT_NOT_FOUND', message: 'Producto no encontrado', requestId: 'req_abc123' };
const ERR_409_STOCK = { error: 'INSUFFICIENT_STOCK', message: 'Stock disponible insuficiente para la operación', requestId: 'req_abc123' };
const ERR_422 = { error: 'VALIDATION_ERROR', message: 'Datos de entrada inválidos', details: [{ field: 'quantity', message: 'must be a positive number' }], requestId: 'req_abc123' };

@ApiTags('stock')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller()
export class StockController {
  constructor(private stockService: StockService) {}

  @Get('stock/movements')
  @ApiOperation({
    summary: 'Historial global de movimientos de stock',
    description: `Lista todos los movimientos de stock del almacén, paginados y opcionalmente filtrados.

Los movimientos son **inmutables** — nunca se editan ni eliminan.

**Tipos de movimiento:**
- \`purchase_receipt\` — ingreso por compra
- \`customer_return\` — devolución de orden cancelada
- \`order_shipment\` — descuento al completar packing
- \`adjustment_increase\` / \`adjustment_decrease\` — ajustes manuales de inventario
- \`transfer_in\` / \`transfer_out\` — traslados entre almacenes

**Ejemplo de llamada:**
\`\`\`http
GET /v1/stock/movements?type=order_shipment&dateFrom=2025-01-01&page=1&limit=50
Authorization: Bearer eyJ...
\`\`\``,
  })
  @ApiQuery({ name: 'warehouseId', required: false, description: 'Filtrar por almacén (default: almacén del usuario)' })
  @ApiQuery({ name: 'type', required: false, enum: MovementType, description: 'Tipo de movimiento' })
  @ApiQuery({ name: 'dateFrom', required: false, description: 'Fecha inicio ISO 8601', example: '2025-01-01' })
  @ApiQuery({ name: 'dateTo', required: false, description: 'Fecha fin ISO 8601', example: '2025-12-31' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 50 })
  @ApiResponse({
    status: 200,
    description: 'Lista paginada de movimientos',
    schema: { example: { data: [MOVEMENT_EXAMPLE], meta: { total: 230, page: 1, limit: 50, totalPages: 5 } } },
  })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  findAll(
    @Query() q: MovementsQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.stockService.findMovements({
      warehouseId: scopeWarehouseFilter(user, q.warehouseId),
      type: q.type,
      dateFrom: q.dateFrom,
      dateTo: q.dateTo,
      page: q.page,
      limit: q.limit,
    });
  }

  @Get('products/:id/movements')
  @ApiOperation({
    summary: 'Historial de movimientos de un producto',
    description: `Lista los movimientos de stock de un producto específico en el almacén.

Útil para auditoría y trazabilidad de un producto.

**Ejemplo de llamada:**
\`\`\`http
GET /v1/products/p001/movements?type=order_shipment&page=1&limit=20
Authorization: Bearer eyJ...
\`\`\``,
  })
  @ApiParam({ name: 'id', description: 'ID del producto', example: 'p001' })
  @ApiQuery({ name: 'warehouseId', required: false, description: 'Filtrar por almacén (default: almacén del usuario)' })
  @ApiQuery({ name: 'type', required: false, enum: MovementType, description: 'Tipo de movimiento' })
  @ApiQuery({ name: 'dateFrom', required: false, description: 'Fecha inicio ISO 8601', example: '2025-01-01' })
  @ApiQuery({ name: 'dateTo', required: false, description: 'Fecha fin ISO 8601', example: '2025-12-31' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiResponse({
    status: 200,
    description: 'Lista paginada de movimientos del producto',
    schema: { example: { data: [MOVEMENT_EXAMPLE], meta: { total: 12, page: 1, limit: 20, totalPages: 1 } } },
  })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  @ApiResponse({ status: 404, description: 'Producto no encontrado', schema: { example: ERR_404_PRODUCT } })
  findByProduct(
    @Param('id') id: string,
    @Query() q: MovementsQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.stockService.findMovements({
      productId: id,
      warehouseId: scopeWarehouseFilter(user, q.warehouseId),
      type: q.type,
      dateFrom: q.dateFrom,
      dateTo: q.dateTo,
      page: q.page,
      limit: q.limit,
    });
  }

  @Post('products/:id/movements')
  @ApiOperation({
    summary: 'Registrar movimiento manual de stock',
    description: `Registra un ajuste o entrada manual de stock para un producto. El movimiento es **inmutable** una vez creado.

Requiere rol **supervisor** o superior y acceso al almacén.

**Tipos permitidos para registro manual:**
- \`opening_balance\` — carga inicial de inventario
- \`purchase_receipt\` — ingreso de mercancía
- \`adjustment_increase\` — corrección positiva de inventario
- \`adjustment_decrease\` — corrección negativa de inventario

Los tipos \`order_shipment\`, \`transfer_in\`/\`transfer_out\` y \`customer_return\` los genera el sistema automáticamente.

**Ejemplo de llamada:**
\`\`\`http
POST /v1/products/p001/movements
Authorization: Bearer eyJ...
Content-Type: application/json

{
  "type": "purchase_receipt",
  "quantity": 50,
  "notes": "Recepción OC-20250601"
}
\`\`\``,
  })
  @ApiParam({ name: 'id', description: 'ID del producto', example: 'p001' })
  @ApiBody({
    schema: {
      example: {
        type: 'purchase_receipt',
        quantity: 50,
        warehouseId: '4f749c36-91a8-4e0f-928f-d8915c2ba8ec',
        notes: 'Recepción OC-20250601',
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Movimiento registrado', schema: { example: MOVEMENT_EXAMPLE } })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  @ApiResponse({ status: 404, description: 'Producto no encontrado', schema: { example: ERR_404_PRODUCT } })
  @ApiResponse({ status: 403, description: 'Rol insuficiente o almacén no permitido', schema: { example: ERR_403 } })
  @ApiResponse({ status: 409, description: 'Stock insuficiente (ajuste negativo)', schema: { example: ERR_409_STOCK } })
  @ApiResponse({ status: 422, description: 'Datos inválidos', schema: { example: ERR_422 } })
  @RequirePermissions('stock.adjust')
  registerMovement(
    @Param('id') productId: string,
    @Body() body: CreateMovementDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.stockService.registerMovement({
      productId,
      warehouseId: resolveWarehouseId(user, body.warehouseId),
      type: body.type,
      quantity: body.quantity,
      notes: body.notes,
      operatorId: user.id,
      operatorName: user.name,
    });
  }

  @Patch('stock/products/:productId/warehouse/:warehouseId')
  @ApiOperation({ summary: 'Actualizar configuración de stock por almacén', description: 'Modifica la ubicación física y el stock mínimo de un producto en un almacén específico.' })
  @ApiParam({ name: 'productId', description: 'ID del producto' })
  @ApiParam({ name: 'warehouseId', description: 'ID del almacén' })
  @ApiBody({ schema: { example: { location: 'A-01-03', minStock: 10 } } })
  @ApiResponse({ status: 200, description: 'Configuración actualizada' })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  @ApiResponse({ status: 403, description: 'Rol insuficiente o almacén no permitido', schema: { example: ERR_403 } })
  @ApiResponse({ status: 404, description: 'Registro de stock no encontrado', schema: { example: ERR_404_PRODUCT } })
  @RequirePermissions('stock.settings')
  updateStockSettings(
    @Param('productId') productId: string,
    @Param('warehouseId') warehouseId: string,
    @Body() body: UpdateStockSettingsDto,
    @CurrentUser() user: AuthUser,
  ) {
    assertWarehouseAccess(user, warehouseId);
    return this.stockService.updateStockSettings({ productId, warehouseId, ...body });
  }

  @Post('stock/transfer')
  @ApiOperation({
    summary: 'Trasladar stock entre almacenes',
    description: `Mueve una cantidad de un producto de un almacén a otro en una **transacción atómica**.

Genera dos movimientos inmutables:
- \`transfer_out\` en el almacén origen
- \`transfer_in\` en el almacén destino

Requiere rol **supervisor** o superior y acceso al almacén origen. Origen y destino deben ser distintos (\`400 SAME_WAREHOUSE\`).

Si el stock disponible en origen es insuficiente devuelve \`409 INSUFFICIENT_STOCK\`.

**Ejemplo de llamada:**
\`\`\`http
POST /v1/stock/transfer
Authorization: Bearer eyJ...
Content-Type: application/json

{
  "productId": "p001",
  "fromWarehouseId": "4f749c36-91a8-4e0f-928f-d8915c2ba8ec",
  "toWarehouseId": "9a3f2b11-cc4d-4a99-b1e0-f2345678abcd",
  "quantity": 10,
  "notes": "Reposición Medellín"
}
\`\`\``,
  })
  @ApiBody({
    schema: {
      example: {
        productId: 'p001',
        fromWarehouseId: '4f749c36-91a8-4e0f-928f-d8915c2ba8ec',
        toWarehouseId: '9a3f2b11-cc4d-4a99-b1e0-f2345678abcd',
        quantity: 10,
        notes: 'Reposición Medellín',
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Traslado ejecutado. Devuelve los dos movimientos generados.',
    schema: {
      example: {
        movements: [
          { ...MOVEMENT_EXAMPLE, type: 'transfer_out', quantity: 10 },
          { ...MOVEMENT_EXAMPLE, type: 'transfer_in', quantity: 10 },
        ],
      },
    },
  })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  @ApiResponse({ status: 403, description: 'Rol insuficiente o almacén origen no permitido', schema: { example: ERR_403 } })
  @ApiResponse({ status: 404, description: 'Producto o almacén no encontrado', schema: { example: ERR_404_PRODUCT } })
  @ApiResponse({ status: 409, description: 'Stock insuficiente en almacén origen', schema: { example: ERR_409_STOCK } })
  @ApiResponse({ status: 422, description: 'Datos inválidos', schema: { example: ERR_422 } })
  @RequirePermissions('stock.transfer')
  transfer(
    @Body() body: TransferDto,
    @CurrentUser() user: AuthUser,
  ) {
    assertWarehouseAccess(user, body.fromWarehouseId);
    return this.stockService.transfer({ ...body, operatorId: user.id, operatorName: user.name });
  }
}
