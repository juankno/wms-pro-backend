import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
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
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/request-with-user.interface';
import { PaginationDto } from '../common/dto/pagination.dto';

const MOVEMENT_EXAMPLE = {
  id: 'mov_001',
  productId: 'p001',
  productCode: 'FLT-0001',
  productName: 'Filtro de Aceite CAT 1R-0716',
  warehouseId: '4f749c36-91a8-4e0f-928f-d8915c2ba8ec',
  warehouseName: 'Bogotá',
  type: 'entrada_compra',
  quantity: 50,
  stockFisicoAntes: 0,
  stockFisicoDespues: 50,
  stockReservadoAntes: 0,
  stockReservadoDespues: 0,
  referenceType: 'manual',
  referenceId: null,
  notes: 'Ingreso inicial',
  operatorId: 'user_001',
  operatorName: 'Juan Supervisor',
  createdAt: '2025-06-01T10:00:00.000Z',
};

const ERR_401 = { error: 'AUTH_TOKEN_EXPIRED', message: 'Token inválido o expirado', requestId: 'req_abc123' };
const ERR_404_PRODUCT = { error: 'PRODUCT_NOT_FOUND', message: 'Producto no encontrado', requestId: 'req_abc123' };
const ERR_409_STOCK = { error: 'STOCK_INSUFICIENTE', message: 'Stock disponible insuficiente para la operación', requestId: 'req_abc123' };
const ERR_422 = { error: 'VALIDATION_ERROR', message: 'Datos de entrada inválidos', details: [{ field: 'quantity', message: 'must be a positive number' }], requestId: 'req_abc123' };

@ApiTags('stock')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller()
export class StockController {
  constructor(private stockService: StockService) {}

  @Get('stock/movements')
  @ApiOperation({
    summary: 'Historial global de movimientos de stock',
    description: `Lista todos los movimientos de stock del almacén, paginados y opcionalmente filtrados.

Los movimientos son **inmutables** — nunca se editan ni eliminan.

**Tipos de movimiento:**
- \`entrada_compra\` — ingreso por compra
- \`entrada_devolucion\` — devolución de orden cancelada
- \`salida_picking\` — descuento al completar packing
- \`ajuste_positivo\` / \`ajuste_negativo\` — ajustes manuales de inventario
- \`traslado_entrada\` / \`traslado_salida\` — traslados entre almacenes

**Ejemplo de llamada:**
\`\`\`http
GET /v1/stock/movements?type=salida_picking&dateFrom=2025-01-01&page=1&limit=50
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
    @Query() q: PaginationDto & { warehouseId?: string; type?: MovementType; dateFrom?: string; dateTo?: string },
    @CurrentUser() user: AuthUser,
  ) {
    return this.stockService.findMovements({
      warehouseId: q.warehouseId ?? user.warehouseId!,
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
GET /v1/products/p001/movements?type=salida_picking&page=1&limit=20
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
    @Query() q: PaginationDto & { warehouseId?: string; type?: MovementType; dateFrom?: string; dateTo?: string },
    @CurrentUser() user: AuthUser,
  ) {
    return this.stockService.findMovements({
      productId: id,
      warehouseId: q.warehouseId ?? user.warehouseId!,
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

**Tipos permitidos para registro manual:**
- \`entrada_compra\` — ingreso de mercancía
- \`ajuste_positivo\` — corrección positiva de inventario
- \`ajuste_negativo\` — corrección negativa de inventario

Los tipos \`salida_picking\`, \`traslado_entrada/salida\` y \`entrada_devolucion\` los genera el sistema automáticamente.

**Ejemplo de llamada:**
\`\`\`http
POST /v1/products/p001/movements
Authorization: Bearer eyJ...
Content-Type: application/json

{
  "type": "entrada_compra",
  "quantity": 50,
  "notes": "Recepción OC-20250601"
}
\`\`\``,
  })
  @ApiParam({ name: 'id', description: 'ID del producto', example: 'p001' })
  @ApiBody({
    schema: {
      example: {
        type: 'entrada_compra',
        quantity: 50,
        warehouseId: '4f749c36-91a8-4e0f-928f-d8915c2ba8ec',
        notes: 'Recepción OC-20250601',
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Movimiento registrado', schema: { example: MOVEMENT_EXAMPLE } })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  @ApiResponse({ status: 404, description: 'Producto no encontrado', schema: { example: ERR_404_PRODUCT } })
  @ApiResponse({ status: 409, description: 'Stock insuficiente (ajuste negativo)', schema: { example: ERR_409_STOCK } })
  @ApiResponse({ status: 422, description: 'Datos inválidos', schema: { example: ERR_422 } })
  registerMovement(
    @Param('id') productId: string,
    @Body() body: { type: MovementType; quantity: number; warehouseId?: string; notes?: string },
    @CurrentUser() user: AuthUser,
  ) {
    return this.stockService.registerMovement({
      productId,
      warehouseId: body.warehouseId ?? user.warehouseId!,
      type: body.type,
      quantity: body.quantity,
      notes: body.notes,
      operatorId: user.id,
      operatorName: user.name,
    });
  }

  @Post('stock/transfer')
  @ApiOperation({
    summary: 'Trasladar stock entre almacenes',
    description: `Mueve una cantidad de un producto de un almacén a otro en una **transacción atómica**.

Genera dos movimientos inmutables:
- \`traslado_salida\` en el almacén origen
- \`traslado_entrada\` en el almacén destino

Si el stock disponible en origen es insuficiente devuelve \`409 STOCK_INSUFICIENTE\`.

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
        salida: { ...MOVEMENT_EXAMPLE, type: 'traslado_salida', quantity: 10 },
        entrada: { ...MOVEMENT_EXAMPLE, type: 'traslado_entrada', quantity: 10 },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  @ApiResponse({ status: 404, description: 'Producto o almacén no encontrado', schema: { example: ERR_404_PRODUCT } })
  @ApiResponse({ status: 409, description: 'Stock insuficiente en almacén origen', schema: { example: ERR_409_STOCK } })
  @ApiResponse({ status: 422, description: 'Datos inválidos', schema: { example: ERR_422 } })
  transfer(
    @Body() body: { productId: string; fromWarehouseId: string; toWarehouseId: string; quantity: number; notes?: string },
    @CurrentUser() user: AuthUser,
  ) {
    return this.stockService.transfer({ ...body, operatorId: user.id, operatorName: user.name });
  }
}
