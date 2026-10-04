import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { ReportsService } from './reports.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/request-with-user.interface';
import { scopeWarehouseFilter } from '../common/utils/warehouse-scope';
import { ReportQueryDto } from './dto/report-query.dto';

const ERR_401 = { error: 'AUTH_TOKEN_EXPIRED', message: 'Token inválido o expirado', requestId: 'req_abc123' };
const ERR_403 = { error: 'AUTH_UNAUTHORIZED', message: 'Acceso denegado', requestId: 'req_abc123' };

@ApiTags('reports')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.supervisor)
@Controller('reports')
export class ReportsController {
  constructor(private reportsService: ReportsService) {}

  @Get('dashboard')
  @ApiOperation({
    summary: 'KPIs del almacén',
    description: `Devuelve los indicadores clave del almacén para el dashboard de la app. **Requiere rol supervisor o admin.**

Todos los conteos son **del día actual** salvo que se indique lo contrario.

**Ejemplo de llamada:**
\`\`\`http
GET /v1/reports/dashboard
Authorization: Bearer eyJ...
\`\`\``,
  })
  @ApiQuery({ name: 'warehouseId', required: false, description: 'Almacén a consultar (solo admin; default: almacén del usuario)' })
  @ApiResponse({
    status: 200,
    description: 'KPIs del almacén',
    schema: {
      example: {
        picking: {
          pendingToday: 3,
          inProgressToday: 2,
          completedToday: 8,
          cancelledToday: 1,
        },
        packing: {
          pendingToday: 2,
          inProgressToday: 1,
          completedToday: 5,
          cancelledToday: 0,
        },
        stock: {
          totalProducts: 87,
          lowStockProducts: 12,
          outOfStockProducts: 4,
          totalStockValue: null,
        },
        activity: {
          eventsToday: 34,
          lastEventAt: '2025-06-01T11:45:00.000Z',
        },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  @ApiResponse({ status: 403, description: 'Rol insuficiente (se requiere supervisor o admin)', schema: { example: ERR_403 } })
  getDashboard(@Query() q: ReportQueryDto, @CurrentUser() user: AuthUser) {
    return this.reportsService.getDashboard(scopeWarehouseFilter(user, q.warehouseId));
  }

  @Get('stock')
  @ApiOperation({
    summary: 'Estado de inventario',
    description: `Devuelve los productos sin stock y con stock bajo para el almacén. **Requiere rol supervisor o admin.**

**Ejemplo de llamada:**
\`\`\`http
GET /v1/reports/stock
Authorization: Bearer eyJ...
\`\`\``,
  })
  @ApiQuery({ name: 'warehouseId', required: false, description: 'Almacén a consultar (solo admin; default: almacén del usuario)' })
  @ApiResponse({
    status: 200,
    description: 'Estado de inventario',
    schema: {
      example: {
        warehouseId: 'wh_001',
        summary: { total: 20, outOfStock: 3, lowStock: 5, ok: 12 },
        outOfStock: [{ id: 'p005', code: 'FLT-0005', name: 'Filtro CAT', stockFisico: 0, stockReservado: 0, stockDisponible: 0, minStock: 5, location: 'A-01-07' }],
        lowStock: [{ id: 'p006', code: 'FLT-0006', name: 'Filtro Aire', stockFisico: 3, stockReservado: 0, stockDisponible: 3, minStock: 5, location: 'A-01-08' }],
      },
    },
  })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  @ApiResponse({ status: 403, description: 'Rol insuficiente', schema: { example: ERR_403 } })
  getStock(@Query() q: ReportQueryDto, @CurrentUser() user: AuthUser) {
    return this.reportsService.getStockStatus(scopeWarehouseFilter(user, q.warehouseId));
  }

  @Get('picking')
  @ApiOperation({
    summary: 'Estadísticas de picking',
    description: 'Totales y desglose por estado de las órdenes de picking. Acepta filtros de fecha. **Requiere rol supervisor o admin.**',
  })
  @ApiQuery({ name: 'warehouseId', required: false })
  @ApiQuery({ name: 'dateFrom', required: false, description: 'Fecha inicio ISO 8601', example: '2025-09-01' })
  @ApiQuery({ name: 'dateTo', required: false, description: 'Fecha fin ISO 8601', example: '2025-09-30' })
  @ApiResponse({
    status: 200,
    schema: { example: { warehouseId: 'wh_001', total: 42, byStatus: { pending: 5, in_progress: 3, completed: 30, cancelled: 4 }, avgItemsPerOrder: 3.2 } },
  })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  @ApiResponse({ status: 403, description: 'Rol insuficiente', schema: { example: ERR_403 } })
  getPickingStats(
    @Query() q: ReportQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.reportsService.getPickingStats(scopeWarehouseFilter(user, q.warehouseId), q.dateFrom, q.dateTo);
  }

  @Get('packing')
  @ApiOperation({
    summary: 'Estadísticas de packing',
    description: 'Totales y desglose por estado de las órdenes de packing. **Requiere rol supervisor o admin.**',
  })
  @ApiQuery({ name: 'warehouseId', required: false })
  @ApiQuery({ name: 'dateFrom', required: false })
  @ApiQuery({ name: 'dateTo', required: false })
  @ApiResponse({
    status: 200,
    schema: { example: { warehouseId: 'wh_001', total: 38, byStatus: { pending: 2, in_progress: 1, completed: 33, cancelled: 2 } } },
  })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  @ApiResponse({ status: 403, description: 'Rol insuficiente', schema: { example: ERR_403 } })
  getPackingStats(
    @Query() q: ReportQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.reportsService.getPackingStats(scopeWarehouseFilter(user, q.warehouseId), q.dateFrom, q.dateTo);
  }

  @Get('stock/movements')
  @ApiOperation({
    summary: 'Resumen de movimientos de stock',
    description: 'Totales de unidades entrantes y salientes en un período, agrupados por tipo. **Requiere rol supervisor o admin.**',
  })
  @ApiQuery({ name: 'warehouseId', required: false })
  @ApiQuery({ name: 'dateFrom', required: false })
  @ApiQuery({ name: 'dateTo', required: false })
  @ApiResponse({
    status: 200,
    schema: {
      example: {
        warehouseId: 'wh_001',
        period: { from: '2025-09-01', to: null },
        entradas: { count: 5, totalUnits: 200 },
        salidas: { count: 12, totalUnits: 310 },
        byType: { purchase_receipt: { count: 3, totalUnits: 150 } },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  @ApiResponse({ status: 403, description: 'Rol insuficiente', schema: { example: ERR_403 } })
  getStockMovements(
    @Query() q: ReportQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.reportsService.getStockMovementsSummary(scopeWarehouseFilter(user, q.warehouseId), q.dateFrom, q.dateTo);
  }
}
