import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Priority } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

class PickingItemDto {
  @ApiProperty() @IsString() @IsNotEmpty() productId!: string;
  @ApiProperty({ minimum: 1 }) @IsInt() @IsPositive() quantity!: number;
}

export class CreatePickingDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(50) reference!: string;
  @ApiPropertyOptional({ description: "Required without customerId; defaults to the customer's name" })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  client?: string;

  @ApiPropertyOptional({ description: 'Active partner flagged as customer' })
  @IsOptional()
  @IsString()
  customerId?: string;

  @ApiPropertyOptional({ description: "Defaults to the user's warehouse" })
  @IsOptional()
  @IsString()
  warehouseId?: string;

  @ApiPropertyOptional({ enum: Priority })
  @IsOptional()
  @IsEnum(Priority)
  priority?: Priority;

  @ApiPropertyOptional() @IsOptional() @IsString() assignedToId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;

  @ApiProperty({ type: [PickingItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PickingItemDto)
  items!: PickingItemDto[];
}

export class UpdatePickingDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @IsNotEmpty() @MaxLength(200) client?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @ApiPropertyOptional({ enum: Priority }) @IsOptional() @IsEnum(Priority) priority?: Priority;
  @ApiPropertyOptional() @IsOptional() @IsString() assignedToId?: string;
}

export const ORDER_TARGET_STATUSES = ['in_progress', 'completed', 'cancelled'] as const;
export type OrderTargetStatus = (typeof ORDER_TARGET_STATUSES)[number];

export class UpdatePickingStatusDto {
  @ApiProperty({ enum: ORDER_TARGET_STATUSES })
  @IsEnum(ORDER_TARGET_STATUSES)
  status!: OrderTargetStatus;
}

export class UpdatePickingItemDto {
  @ApiProperty({ minimum: 0 }) @IsInt() @Min(0) pickedQuantity!: number;

  @ApiPropertyOptional({
    description: 'Location the units come from (or return to when the quantity decreases). Omitted: taken in pick sequence.',
  })
  @IsOptional()
  @IsString()
  locationId?: string;

  @ApiPropertyOptional({ description: 'Lot taken (or returned). Omitted: first expired, first out.' })
  @IsOptional()
  @IsString()
  lotId?: string;
}

export class AddPhotoDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(500) url!: string;
}
