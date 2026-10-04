import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { ORDER_TARGET_STATUSES, OrderTargetStatus } from '../../picking/dto/create-picking.dto';

export class CreatePackingDto {
  @ApiProperty() @IsString() @IsNotEmpty() pickingOrderId!: string;
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(50) reference!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() assignedToId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class UpdatePackingDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() assignedToId?: string;
  @ApiPropertyOptional({ minimum: 0 }) @IsOptional() @IsNumber() @Min(0) totalWeight?: number;
}

export class UpdatePackingStatusDto {
  @ApiProperty({ enum: ORDER_TARGET_STATUSES })
  @IsEnum(ORDER_TARGET_STATUSES)
  status!: OrderTargetStatus;
}

export class UpdatePackingItemDto {
  @ApiProperty({ minimum: 0 }) @IsInt() @Min(0) packedQuantity!: number;
}

export class AddBoxDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(50) label!: string;
}
