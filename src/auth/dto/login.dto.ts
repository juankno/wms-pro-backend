import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({
    example: 'acme',
    required: false,
    description: 'Slug de la empresa. Obligatorio cuando existe más de una empresa activa.',
  })
  @IsOptional()
  @Matches(/^[a-z0-9-]{2,40}$/, { message: 'tenant must be a valid company slug' })
  tenant?: string;

  @ApiProperty({ example: 'operario', description: 'Nombre de usuario' })
  @IsString()
  username!: string;

  @ApiProperty({ example: 'op123', description: 'Contraseña del usuario', minLength: 4 })
  @IsString()
  @MinLength(4)
  password!: string;
}
