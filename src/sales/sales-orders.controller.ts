import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/request-with-user.interface';
import { scopeWarehouseFilter } from '../common/utils/warehouse-scope';
import { CreateSalesOrderDto, ReleaseSalesOrderDto, SalesOrderQueryDto } from './dto/sales-order.dto';
import { SalesOrdersService } from './sales-orders.service';

@ApiTags('sales-orders')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('sales-orders')
export class SalesOrdersController {
  constructor(private orders: SalesOrdersService) {}

  @Get()
  @ApiOperation({ summary: 'Pedidos de venta', description: 'Filtra por estado (varios separados por coma), cliente, almacén o texto.' })
  findAll(@Query() query: SalesOrderQueryDto, @CurrentUser() user: AuthUser) {
    return this.orders.findAll({ ...query, warehouseId: scopeWarehouseFilter(user, query.warehouseId) });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle con cantidades pedidas, liberadas y despachadas y sus pickings' })
  findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.orders.findById(id, user);
  }

  @Post()
  @RequirePermissions('sales.manage')
  @ApiOperation({ summary: 'Crear pedido de venta (no reserva stock hasta liberarlo)' })
  create(@Body() dto: CreateSalesOrderDto, @CurrentUser() user: AuthUser) {
    return this.orders.create(dto, user);
  }

  @Post(':id/release')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('sales.manage')
  @ApiOperation({
    summary: 'Liberar el pedido: reserva y crea la orden de picking',
    description: 'Sin stock suficiente responde 409; con `allowPartial` libera lo disponible y deja el resto pendiente.',
  })
  release(@Param('id') id: string, @Body() dto: ReleaseSalesOrderDto, @CurrentUser() user: AuthUser) {
    return this.orders.release(id, dto, user);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('sales.manage')
  @ApiOperation({ summary: 'Cancelar lo que no se ha despachado' })
  cancel(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.orders.cancel(id, user);
  }
}
