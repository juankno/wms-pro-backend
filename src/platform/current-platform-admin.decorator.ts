import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { PlatformPrincipal } from './platform-jwt.strategy';

export const CurrentPlatformAdmin = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): PlatformPrincipal =>
    ctx.switchToHttp().getRequest<Request & { user: PlatformPrincipal }>().user,
);
