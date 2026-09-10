import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'operario', description: 'Nombre de usuario' })
  @IsString()
  username: string;

  @ApiProperty({ example: 'op123', description: 'Contraseña del usuario', minLength: 4 })
  @IsString()
  @MinLength(4)
  password: string;
}
