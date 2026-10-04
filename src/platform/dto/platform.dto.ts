import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TenantStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../../auth/dto/change-password.dto';
import { PLAN_LIMITS } from '../../tenancy/plans';

const PLANS = Object.keys(PLAN_LIMITS);
const SLUG = /^[a-z0-9-]{2,40}$/;

export class PlatformLoginDto {
  @ApiProperty() @IsEmail() email!: string;
  @ApiProperty() @IsString() @IsNotEmpty() password!: string;
}

class TenantAdminDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(50) username!: string;
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(100) name!: string;
  @ApiProperty() @IsEmail() email!: string;

  @ApiProperty({ minLength: PASSWORD_MIN_LENGTH })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;
}

export class CreateTenantDto {
  @ApiProperty({ example: 'acme' })
  @Matches(SLUG, { message: 'slug must be 2-40 lowercase letters, digits or dashes' })
  slug!: string;

  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(100) name!: string;
  @ApiPropertyOptional({ enum: PLANS }) @IsOptional() @IsIn(PLANS) plan?: string;

  @ApiProperty({ type: TenantAdminDto })
  @ValidateNested()
  @Type(() => TenantAdminDto)
  admin!: TenantAdminDto;
}

class LimitsDto {
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(0) users?: number | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(0) warehouses?: number | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(0) ordersPerMonth?: number | null;
}

export class UpdateTenantDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100) name?: string;
  @ApiPropertyOptional({ enum: PLANS }) @IsOptional() @IsIn(PLANS) plan?: string;
  @ApiPropertyOptional({ enum: TenantStatus }) @IsOptional() @IsEnum(TenantStatus) status?: TenantStatus;

  @ApiPropertyOptional({ type: LimitsDto, description: 'Overrides of the plan limits; null means unlimited' })
  @IsOptional()
  @ValidateNested()
  @Type(() => LimitsDto)
  limits?: LimitsDto;
}
