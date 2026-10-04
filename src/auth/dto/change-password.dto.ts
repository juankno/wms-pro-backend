import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export const PASSWORD_MIN_LENGTH = 8;
// bcrypt ignores input beyond 72 bytes.
export const PASSWORD_MAX_LENGTH = 72;

export class ChangePasswordDto {
  @ApiProperty() @IsString() @IsNotEmpty() currentPassword!: string;

  @ApiProperty({ minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  newPassword!: string;
}
