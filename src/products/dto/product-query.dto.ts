import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';

export class ProductQueryDto extends PaginationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({ enum: ['ok', 'low', 'out'] })
  @IsOptional()
  @IsIn(['ok', 'low', 'out'])
  stockStatus?: 'ok' | 'low' | 'out';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  warehouseId?: string;
}
