import { ApiProperty, ApiPropertyOptional, PartialType, PickType } from '@nestjs/swagger';
import { LocationType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';

const LOCATION_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CODE_MESSAGE = 'El código solo admite letras, números, punto, guion y guion bajo';

export class CreateLocationDto {
  @ApiProperty() @IsString() warehouseId!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() parentId?: string;

  @ApiProperty({ example: 'A-01-2' })
  @IsString()
  @MaxLength(40)
  @Matches(LOCATION_CODE, { message: CODE_MESSAGE })
  code!: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100) name?: string;
  @ApiProperty({ enum: LocationType }) @IsEnum(LocationType) type!: LocationType;

  @ApiPropertyOptional({ description: 'Defaults to true for bin, dock and staging' })
  @IsOptional()
  @IsBoolean()
  storable?: boolean;

  @ApiPropertyOptional({ nullable: true, description: 'Maximum units; null is unlimited' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(1)
  capacity?: number | null;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) pickSequence?: number;

  @ApiPropertyOptional({ type: Object, description: 'Values of the custom fields, keyed by field key; null clears one' })
  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;
}

export class UpdateLocationDto extends PartialType(
  PickType(CreateLocationDto, ['code', 'name', 'storable', 'capacity', 'pickSequence', 'customFields'] as const),
) {
  @ApiPropertyOptional({ nullable: true, description: 'null moves the location to the warehouse root' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  parentId?: string | null;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() active?: boolean;
}

class LevelDto {
  @ApiProperty({ enum: LocationType }) @IsEnum(LocationType) type!: LocationType;

  @ApiProperty({ example: '01', description: 'Digits keep their zero padding; a single letter counts A, B, C…' })
  @Matches(/^(\d{1,4}|[A-Za-z])$/, { message: 'Usa números o una sola letra' })
  start!: string;

  @ApiProperty({ example: 10 }) @IsInt() @Min(1) @Max(100) count!: number;
}

export class GenerateLocationsDto {
  @ApiProperty() @IsString() warehouseId!: string;
  @ApiPropertyOptional({ description: 'Location under which the new levels are created' })
  @IsOptional()
  @IsString()
  parentId?: string;

  @ApiProperty({ type: [LevelDto] })
  @ValidateNested({ each: true })
  @Type(() => LevelDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(6)
  levels!: LevelDto[];
}

export class LocationQueryDto extends PaginationDto {
  @ApiProperty() @IsString() warehouseId!: string;

  @ApiPropertyOptional({ description: 'Id of the parent, or "root" for top-level locations' })
  @IsOptional()
  @IsString()
  parentId?: string;

  @ApiPropertyOptional({ enum: LocationType }) @IsOptional() @IsEnum(LocationType) type?: LocationType;
  @ApiPropertyOptional({ description: 'Code or name contains' }) @IsOptional() @IsString() search?: string;
}
