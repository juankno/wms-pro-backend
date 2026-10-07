import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { JobStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PaginationDto } from '../common/dto/pagination.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/request-with-user.interface';
import { JobsService } from './jobs.service';

class JobQueryDto extends PaginationDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) type?: string;
  @ApiPropertyOptional({ enum: JobStatus }) @IsOptional() @IsEnum(JobStatus) status?: JobStatus;
}

@ApiTags('jobs')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('jobs')
export class JobsController {
  constructor(private jobs: JobsService) {}

  @Get()
  @ApiOperation({ summary: 'Trabajos en segundo plano (propios, o de toda la empresa con jobs.manage)' })
  findAll(@Query() query: JobQueryDto, @CurrentUser() user: AuthUser) {
    return this.jobs.findAll(query, user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle con progreso, resultado y error' })
  findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.jobs.findById(id, user);
  }

  @Post(':id/retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Volver a encolar un trabajo fallido' })
  retry(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.jobs.retry(id, user);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancelar un trabajo que aún no empezó' })
  cancel(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.jobs.cancel(id, user);
  }
}
