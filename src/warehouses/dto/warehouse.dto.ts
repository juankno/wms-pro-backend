import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class CreateWarehouseDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(100) name!: string;

  @ApiProperty({ example: 'BOG-01' })
  @IsString()
  @Matches(/^[A-Z0-9-]{2,20}$/, { message: 'code must be 2-20 uppercase letters, digits or dashes' })
  code!: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(255) address?: string;
}

export class UpdateWarehouseDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(255) address?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() active?: boolean;
}
