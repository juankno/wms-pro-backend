import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { authConfig } from '../config/env';
import { PlatformJwtStrategy } from './platform-jwt.strategy';
import { PlatformController } from './platform.controller';
import { PlatformService } from './platform.service';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    AuditModule,
    JwtModule.registerAsync({
      useFactory: () => {
        const { accessSecret, accessTtlSeconds } = authConfig();
        return { secret: accessSecret, signOptions: { expiresIn: accessTtlSeconds } };
      },
    }),
  ],
  controllers: [PlatformController],
  providers: [PlatformService, PlatformJwtStrategy],
})
export class PlatformModule {}
