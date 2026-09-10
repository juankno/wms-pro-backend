import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class RefreshTokenDto {
  @ApiProperty({
    example: 'b0d4a15f-38b5-4723-a83e-ffa35b2360b6',
    description: 'Refresh token obtenido en el login',
  })
  @IsString()
  refreshToken: string;
}
