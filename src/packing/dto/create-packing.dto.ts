import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEnum, IsOptional, IsString } from "class-validator";

export class CreatePackingDto {
  @ApiProperty() @IsString() pickingOrderId: string;
  @ApiPropertyOptional() @IsOptional() @IsString() assignedToId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

export class UpdatePackingStatusDto {
  @ApiProperty({ enum: ["in_progress", "completed", "cancelled"] })
  @IsEnum(["in_progress", "completed", "cancelled"])
  status: "in_progress" | "completed" | "cancelled";
}

export class AddBoxDto {
  @ApiProperty() @IsString() label: string;
}
