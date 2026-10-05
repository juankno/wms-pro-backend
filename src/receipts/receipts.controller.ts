import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/request-with-user.interface';
import { scopeWarehouseFilter } from '../common/utils/warehouse-scope';
import { AddReceiptLineDto, CompleteReceiptDto, CreateReceiptDto, ReceiptQueryDto, UpdateReceiptLineDto } from './dto/receipt.dto';
import { ReceiptsService } from './receipts.service';

@ApiTags('receipts')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('receiving.execute')
@Controller('receipts')
export class ReceiptsController {
  constructor(private receipts: ReceiptsService) {}

  @Get()
  @ApiOperation({ summary: 'Recepciones', description: 'Filtra por estado, almacén u orden de compra.' })
  findAll(@Query() query: ReceiptQueryDto, @CurrentUser() user: AuthUser) {
    return this.receipts.findAll({ ...query, warehouseId: scopeWarehouseFilter(user, query.warehouseId) });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle con líneas, lo esperado de la orden y sugerencia de ubicación' })
  findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.receipts.findById(id, user);
  }

  @Post()
  @ApiOperation({ summary: 'Abrir una recepción contra una orden de compra o sin orden' })
  create(@Body() dto: CreateReceiptDto, @CurrentUser() user: AuthUser) {
    return this.receipts.create(dto, user);
  }

  @Post(':id/lines')
  @ApiOperation({ summary: 'Registrar unidades recibidas (con ubicación y lote opcionales)' })
  addLine(@Param('id') id: string, @Body() dto: AddReceiptLineDto, @CurrentUser() user: AuthUser) {
    return this.receipts.addLine(id, dto, user);
  }

  @Patch(':id/lines/:lineId')
  @ApiOperation({ summary: 'Corregir cantidad, ubicación o lote de una línea' })
  updateLine(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() dto: UpdateReceiptLineDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.receipts.updateLine(id, lineId, dto, user);
  }

  @Delete(':id/lines/:lineId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Quitar una línea de una recepción abierta' })
  async removeLine(@Param('id') id: string, @Param('lineId') lineId: string, @CurrentUser() user: AuthUser) {
    await this.receipts.removeLine(id, lineId, user);
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Completar la recepción: entra el stock y se actualiza la orden',
    description: 'Devuelve las diferencias por producto (pedido, recibido, pendiente, excedente). Recibir de más exige `allowOverReceipt`.',
  })
  complete(@Param('id') id: string, @Body() dto: CompleteReceiptDto, @CurrentUser() user: AuthUser) {
    return this.receipts.complete(id, dto.allowOverReceipt ?? false, user);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancelar una recepción abierta sin mover stock' })
  cancel(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.receipts.cancel(id, user);
  }
}
