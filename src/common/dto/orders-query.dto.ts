import { ApiPropertyOptional } from '@nestjs/swagger';
import { OrderStatus } from '@prisma/client';
import { IsDateString, IsEnum, IsOptional, IsString } from 'class-validator';
import { PaginationDto } from './pagination.dto';

export class OrdersQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: OrderStatus })
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  @ApiPropertyOptional({ description: 'Assigned user id' })
  @IsOptional()
  @IsString()
  assignedTo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ example: '2025-01-01' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ example: '2025-12-31' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ description: "Defaults to the user's warehouse; admins see all when omitted" })
  @IsOptional()
  @IsString()
  warehouseId?: string;
}
