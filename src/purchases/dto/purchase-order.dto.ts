import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PurchaseOrderStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';

export class PurchaseOrderItemDto {
  @ApiProperty() @IsString() @IsNotEmpty() productId!: string;
  @ApiProperty({ minimum: 1 }) @IsInt() @IsPositive() quantity!: number;
}

export class CreatePurchaseOrderDto {
  @ApiProperty({ example: 'OC-2026-001' }) @IsString() @IsNotEmpty() @MaxLength(50) reference!: string;
  @ApiProperty({ description: 'Active partner flagged as supplier' }) @IsString() @IsNotEmpty() supplierId!: string;
  @ApiProperty() @IsString() @IsNotEmpty() warehouseId!: string;
  @ApiPropertyOptional({ example: '2026-10-20' }) @IsOptional() @IsDateString() expectedAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;

  @ApiProperty({ type: [PurchaseOrderItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderItemDto)
  items!: PurchaseOrderItemDto[];
}

export class UpdatePurchaseOrderDto {
  @ApiPropertyOptional() @IsOptional() @IsDateString() expectedAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;

  @ApiPropertyOptional({ type: [PurchaseOrderItemDto], description: 'Replaces the items; only before receiving' })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderItemDto)
  items?: PurchaseOrderItemDto[];
}

export class PurchaseOrderQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: PurchaseOrderStatus }) @IsOptional() @IsEnum(PurchaseOrderStatus) status?: PurchaseOrderStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() supplierId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() warehouseId?: string;
  @ApiPropertyOptional({ description: 'Reference or supplier name contains' }) @IsOptional() @IsString() search?: string;
}
