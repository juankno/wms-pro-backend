import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ReceiptStatus } from '@prisma/client';
import { IsBoolean, IsDateString, IsEnum, IsInt, IsNotEmpty, IsOptional, IsPositive, IsString, MaxLength } from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';

export class CreateReceiptDto {
  @ApiPropertyOptional({ description: 'Receive against this order; its warehouse and supplier are used' })
  @IsOptional()
  @IsString()
  purchaseOrderId?: string;

  @ApiPropertyOptional({ description: 'Required for blind receipts' }) @IsOptional() @IsString() warehouseId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() supplierId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class AddReceiptLineDto {
  @ApiProperty() @IsString() @IsNotEmpty() productId!: string;
  @ApiProperty({ minimum: 1 }) @IsInt() @IsPositive() quantity!: number;
  @ApiPropertyOptional({ description: 'Put-away location; omitted: units stay without location' })
  @IsOptional()
  @IsString()
  locationId?: string;

  @ApiPropertyOptional({ description: 'Required for lot-tracked products' }) @IsOptional() @IsString() @MaxLength(50) lot?: string;
  @ApiPropertyOptional({ example: '2027-06-30' }) @IsOptional() @IsDateString() lotExpiresAt?: string;
}

export class CompleteReceiptDto {
  @ApiPropertyOptional({ default: false, description: 'Accept more units than ordered' })
  @IsOptional()
  @IsBoolean()
  allowOverReceipt?: boolean;
}

export class ReceiptQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: ReceiptStatus }) @IsOptional() @IsEnum(ReceiptStatus) status?: ReceiptStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() warehouseId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() purchaseOrderId?: string;
}
