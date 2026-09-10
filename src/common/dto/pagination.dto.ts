import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class PaginationDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}

export function paginate(page: number, limit: number) {
  const p = Math.max(1, +page || 1);
  const l = Math.max(1, +limit || 20);
  return { skip: (p - 1) * l, take: l };
}

export function buildMeta(total: number, page: number, limit: number) {
  const p = Math.max(1, +page || 1);
  const l = Math.max(1, +limit || 20);
  return { total: +total, page: p, limit: l, totalPages: Math.ceil(total / l) };
}
