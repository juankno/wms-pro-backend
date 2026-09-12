import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { ActivityService } from './activity.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PaginationDto } from '../common/dto/pagination.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/request-with-user.interface';

const ACTIVITY_EXAMPLE = {
  id: 'act_001',
  orderId: 'pick_001',
  orderType: 'picking',
  action: 'in_progress',
  detail: 'Picking in_progress',
  operator: 'María Operaria',
  userId: 'user_002',
  warehouseId: '4f749c36-91a8-4e0f-928f-d8915c2ba8ec',
  createdAt: '2025-06-01T09:05:00.000Z',
};

const ERR_401 = { error: 'AUTH_TOKEN_EXPIRED', message: 'Token inválido o expirado', requestId: 'req_abc123' };

@ApiTags('activity')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('activity')
export class ActivityController {
  constructor(private activityService: ActivityService) {}

  @Get()
  @ApiOperation({
    summary: 'Historial de actividad global',
    description: `Devuelve el log de auditoría paginado del almacén. Cada entrada es **inmutable** y se genera automáticamente al cambiar estados de órdenes.

- **Operators** ven solo su almacén
- **Supervisores y admins** ven todos los almacenes

**Acciones registradas:**
| Acción | Descripción |
|--------|-------------|
| \`in_progress\` | Orden iniciada |
| \`completed\` | Orden completada |
| \`cancelled\` | Orden cancelada |
| \`stock_confirmed\` | Stock descontado al completar packing |
| \`item_picked\` | Ítem recogido durante picking |

**Ejemplo de llamada:**
\`\`\`http
GET /v1/activity?page=1&limit=50
Authorization: Bearer eyJ...
\`\`\``,
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 50 })
  @ApiResponse({
    status: 200,
    description: 'Log de actividad paginado',
    schema: { example: { data: [ACTIVITY_EXAMPLE], meta: { total: 320, page: 1, limit: 50, totalPages: 7 } } },
  })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  findAll(@Query() q: PaginationDto, @CurrentUser() user: AuthUser) {
    const warehouseId =
      user.role === Role.admin || user.role === Role.supervisor ? undefined : user.warehouseId!;
    return this.activityService.findAll(q.page, q.limit, warehouseId);
  }

  @Get('order/:orderId')
  @ApiOperation({
    summary: 'Actividad de una orden',
    description: `Devuelve el historial completo de una orden específica (picking o packing). Útil para auditar el ciclo de vida de una orden.

**Ejemplo de llamada:**
\`\`\`http
GET /v1/activity/order/pick_001
Authorization: Bearer eyJ...
\`\`\``,
  })
  @ApiParam({ name: 'orderId', description: 'ID de la orden (picking o packing)', example: 'pick_001' })
  @ApiResponse({
    status: 200,
    description: 'Actividad de la orden, ordenada por fecha ascendente',
    schema: {
      example: [
        { ...ACTIVITY_EXAMPLE, action: 'in_progress', createdAt: '2025-06-01T09:05:00.000Z' },
        { ...ACTIVITY_EXAMPLE, action: 'item_picked', detail: 'FLT-0001: 7 recogidos', createdAt: '2025-06-01T09:30:00.000Z' },
        { ...ACTIVITY_EXAMPLE, action: 'completed', createdAt: '2025-06-01T10:00:00.000Z' },
      ],
    },
  })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  findByOrder(@Param('orderId') orderId: string) {
    return this.activityService.findByOrder(orderId);
  }
}
