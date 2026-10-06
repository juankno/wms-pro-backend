import { Module } from '@nestjs/common';
import { InvitationsController, PublicInvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';

@Module({
  providers: [InvitationsService],
  controllers: [InvitationsController, PublicInvitationsController],
})
export class InvitationsModule {}
