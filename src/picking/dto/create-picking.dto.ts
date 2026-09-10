import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  ValidateNested,
} from "class-validator";

class PickingItemDto {
  @ApiProperty() @IsString() productId: string;
  @ApiProperty() @IsInt() @IsPositive() quantity: number;
}

export class CreatePickingDto {
  @ApiProperty() @IsString() reference: string;
  @ApiProperty() @IsString() client: string;
  @ApiProperty() @IsString() warehouseId: string;
  @ApiPropertyOptional({ enum: ["low", "medium", "high"] })
  @IsOptional()
  @IsEnum(["low", "medium", "high"])
  priority?: "low" | "medium" | "high";
  @ApiPropertyOptional() @IsOptional() @IsString() assignedToId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  @ApiProperty({ type: [PickingItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PickingItemDto)
  items: PickingItemDto[];
}

export class UpdatePickingStatusDto {
  @ApiProperty({ enum: ["in_progress", "completed", "cancelled"] })
  @IsEnum(["in_progress", "completed", "cancelled"])
  status: "in_progress" | "completed" | "cancelled";
}

export class UpdatePickingItemDto {
  @ApiProperty() @IsInt() @IsPositive() pickedQuantity: number;
}
