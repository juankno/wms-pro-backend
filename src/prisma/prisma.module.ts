import { Global, Module } from '@nestjs/common';
import { createPrismaClient, PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [{ provide: PrismaService, useFactory: () => createPrismaClient() }],
  exports: [PrismaService],
})
export class PrismaModule {}
