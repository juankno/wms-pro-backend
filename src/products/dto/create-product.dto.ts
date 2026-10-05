import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsInt, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class CreateProductDto {
  @ApiProperty()
  @IsString()
  code!: string;

  @ApiProperty()
  @IsString()
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty()
  @IsString()
  category!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  barcode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  unit?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  brand?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  compatibility?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  imageUrl?: string;

  @ApiPropertyOptional({ default: false, description: 'Require lots and ship first-expired-first-out' })
  @IsOptional()
  @IsBoolean()
  lotTracking?: boolean;

  @ApiPropertyOptional({ type: Object, description: 'Values of the custom fields, keyed by field key; null clears one' })
  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;
}

export class UpdateProductDto extends PartialType(CreateProductDto) {
  @ApiPropertyOptional({ description: 'Deactivating requires products.delete' }) @IsOptional() @IsBoolean() active?: boolean;
}

export class AddBarcodeDto {
  @ApiProperty({ example: '17891234560008' }) @IsString() @IsNotEmpty() @MaxLength(50) code!: string;

  @ApiPropertyOptional({ default: 1, description: 'Base units counted per scan, e.g. 12 for a box' })
  @IsOptional()
  @IsInt()
  @Min(1)
  quantity?: number;

  @ApiPropertyOptional({ example: 'Caja x12' }) @IsOptional() @IsString() @MaxLength(50) label?: string;
}
