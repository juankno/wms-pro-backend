import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { IsEmail, IsEnum, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../../auth/dto/change-password.dto';

export class CreateInvitationDto {
  @ApiProperty() @IsEmail() email!: string;
  @ApiProperty({ enum: Role }) @IsEnum(Role) role!: Role;
  @ApiPropertyOptional() @IsOptional() @IsString() customRoleId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() warehouseId?: string;
}

export class AcceptInvitationDto {
  @ApiProperty({ example: 'jperez' })
  @IsString()
  @MaxLength(50)
  @Matches(/^[a-zA-Z0-9._-]+$/, { message: 'El usuario solo admite letras, números, punto, guion y guion bajo' })
  username!: string;

  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(100) name!: string;

  @ApiProperty({ minLength: PASSWORD_MIN_LENGTH })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;
}
