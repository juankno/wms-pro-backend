import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, IsPositive, IsString } from 'class-validator';

const MANUAL_TYPES = [
  'inventario_inicial',
  'entrada_compra',
  'entrada_traslado',
  'salida_traslado',
  'ajuste_positivo',
  'ajuste_negativo',
] as const;

export class CreateMovementDto {
  @ApiProperty({ enum: MANUAL_TYPES })
  @IsEnum(MANUAL_TYPES)
  type: typeof MANUAL_TYPES[number];

  @ApiProperty()
  @IsInt()
  @IsPositive()
  quantity: number;

  @ApiProperty()
  @IsString()
  warehouseId: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class TransferDto {
  @ApiProperty() @IsString() productId: string;
  @ApiProperty() @IsString() fromWarehouseId: string;
  @ApiProperty() @IsString() toWarehouseId: string;
  @ApiProperty() @IsInt() @IsPositive() quantity: number;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}
