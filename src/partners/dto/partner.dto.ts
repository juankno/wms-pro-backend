import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';

export const PARTNER_KINDS = ['customer', 'supplier'] as const;
export type PartnerKind = (typeof PARTNER_KINDS)[number];

export class CreatePartnerDto {
  @ApiProperty({ example: 'CLI-001' })
  @IsString()
  @MaxLength(30)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, { message: 'El código solo admite letras, números, punto, guion y guion bajo' })
  code!: string;

  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(200) name!: string;
  @ApiPropertyOptional({ description: 'NIT, RUT, RFC…' }) @IsOptional() @IsString() @MaxLength(30) taxId?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(30) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) address?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) city?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) country?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) contactName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @ApiPropertyOptional({ default: false }) @IsOptional() @IsBoolean() isCustomer?: boolean;
  @ApiPropertyOptional({ default: false }) @IsOptional() @IsBoolean() isSupplier?: boolean;
}

export class UpdatePartnerDto extends PartialType(CreatePartnerDto) {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() active?: boolean;
}

export class PartnerQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: PARTNER_KINDS }) @IsOptional() @IsIn(PARTNER_KINDS) kind?: PartnerKind;
  @ApiPropertyOptional({ description: 'Code, name or tax id contains' }) @IsOptional() @IsString() search?: string;

  @ApiPropertyOptional({ description: 'Include inactive partners', default: false })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeInactive?: boolean;
}
