import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Priority, SalesOrderStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
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
import { splitList } from '../../common/dto/list-transform';
import { PaginationDto } from '../../common/dto/pagination.dto';

export class SalesOrderItemDto {
  @ApiProperty() @IsString() @IsNotEmpty() productId!: string;
  @ApiProperty({ minimum: 1 }) @IsInt() @IsPositive() quantity!: number;
}

export class CreateSalesOrderDto {
  @ApiPropertyOptional({ description: 'Generated from the tenant sequence when omitted (PV-00001)' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  reference?: string;

  @ApiPropertyOptional({ description: 'Active partner flagged as customer' }) @IsOptional() @IsString() customerId?: string;
  @ApiPropertyOptional({ description: "Required without customerId; defaults to the customer's name" })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  client?: string;

  @ApiProperty() @IsString() @IsNotEmpty() warehouseId!: string;
  @ApiPropertyOptional({ enum: Priority }) @IsOptional() @IsEnum(Priority) priority?: Priority;
  @ApiPropertyOptional({ example: '2026-10-20' }) @IsOptional() @IsDateString() requestedAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;

  @ApiProperty({ type: [SalesOrderItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SalesOrderItemDto)
  items!: SalesOrderItemDto[];
}

export class ReleaseSalesOrderDto {
  @ApiPropertyOptional({ default: false, description: 'Release what is available and leave the rest pending' })
  @IsOptional()
  @IsBoolean()
  allowPartial?: boolean;

  @ApiPropertyOptional({ description: 'Picker of the generated picking order' }) @IsOptional() @IsString() assignedToId?: string;
}

export class SalesOrderQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: SalesOrderStatus, isArray: true, description: 'One or more, comma-separated' })
  @IsOptional()
  @Transform(splitList)
  @IsEnum(SalesOrderStatus, { each: true })
  status?: SalesOrderStatus[];

  @ApiPropertyOptional() @IsOptional() @IsString() customerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() warehouseId?: string;
  @ApiPropertyOptional({ description: 'Reference or client contains' }) @IsOptional() @IsString() search?: string;
}
