import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

const USER_SUMMARY_EXAMPLE = { id: 'ebe9a6f3-d616-46a9-af58-4ed21e4525f0', username: 'operario', name: 'Juan Operario', role: 'operator' };

@ApiTags('users')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(private usersService: UsersService) {}

  @Get('warehouse/:warehouseId')
  @ApiOperation({
    summary: 'Operarios de un almacén',
    description: 'Lista los usuarios activos asignados a un almacén. Útil para el selector de "asignar a" en picking/packing.',
  })
  @ApiParam({ name: 'warehouseId', example: '4f749c36-91a8-4e0f-928f-d8915c2ba8ec' })
  @ApiResponse({
    status: 200,
    description: 'Lista de usuarios del almacén',
    schema: { example: [USER_SUMMARY_EXAMPLE] },
  })
  findByWarehouse(@Param('warehouseId') warehouseId: string) {
    return this.usersService.findByWarehouse(warehouseId);
  }
}
