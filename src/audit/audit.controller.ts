import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PaginationDto } from '../common/dto/pagination.dto';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { AuditService } from './audit.service';
import { RequirePermissions } from '../auth/permissions.decorator';

class AuditQueryDto extends PaginationDto {
  @ApiPropertyOptional() @IsOptional() @IsString() actorId?: string;
  @ApiPropertyOptional({ example: 'products' }) @IsOptional() @IsString() resource?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() resourceId?: string;
  @ApiPropertyOptional({ example: '2025-01-01' }) @IsOptional() @IsDateString() dateFrom?: string;
  @ApiPropertyOptional({ example: '2025-12-31' }) @IsOptional() @IsDateString() dateTo?: string;
}

@ApiTags('audit')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('audit')
export class AuditController {
  constructor(private auditService: AuditService) {}

  @Get()
  @RequirePermissions('audit.read')
  @ApiOperation({
    summary: 'Registro de auditoría de la empresa',
    description: 'Cambios hechos por los usuarios (crear, actualizar, eliminar), con los datos enviados y los secretos censurados.',
  })
  findAll(@Query() q: AuditQueryDto) {
    return this.auditService.findAll(q);
  }
}
