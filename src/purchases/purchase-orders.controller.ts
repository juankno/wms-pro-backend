import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/request-with-user.interface';
import { scopeWarehouseFilter } from '../common/utils/warehouse-scope';
import { CreatePurchaseOrderDto, PurchaseOrderQueryDto, UpdatePurchaseOrderDto } from './dto/purchase-order.dto';
import { PurchaseOrdersService } from './purchase-orders.service';

@ApiTags('purchase-orders')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('purchase-orders')
export class PurchaseOrdersController {
  constructor(private orders: PurchaseOrdersService) {}

  @Get()
  @ApiOperation({ summary: 'Órdenes de compra', description: 'Filtra por estado, proveedor, almacén o texto.' })
  findAll(@Query() query: PurchaseOrderQueryDto, @CurrentUser() user: AuthUser) {
    return this.orders.findAll({ ...query, warehouseId: scopeWarehouseFilter(user, query.warehouseId) });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle con ítems pedidos y recibidos' })
  findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.orders.findById(id, user);
  }

  @Post()
  @RequirePermissions('purchases.manage')
  @ApiOperation({ summary: 'Crear orden de compra a un proveedor' })
  create(@Body() dto: CreatePurchaseOrderDto, @CurrentUser() user: AuthUser) {
    return this.orders.create(dto, user);
  }

  @Patch(':id')
  @RequirePermissions('purchases.manage')
  @ApiOperation({ summary: 'Editar fecha esperada, notas o ítems (los ítems solo antes de recibir)' })
  update(@Param('id') id: string, @Body() dto: UpdatePurchaseOrderDto, @CurrentUser() user: AuthUser) {
    return this.orders.update(id, dto, user);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('purchases.manage')
  @ApiOperation({ summary: 'Cancelar una orden sin unidades recibidas' })
  cancel(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.orders.cancel(id, user);
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('purchases.manage')
  @ApiOperation({ summary: 'Cerrar una orden recibida parcialmente; lo pendiente ya no llegará' })
  close(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.orders.close(id, user);
  }
}
