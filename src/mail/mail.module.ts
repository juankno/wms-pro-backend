import { Global, Module } from '@nestjs/common';
import { mailConfig } from '../config/env';
import { LogMailer, Mailer, SmtpMailer } from './mailer';

@Global()
@Module({
  providers: [
    {
      provide: Mailer,
      useFactory: (): Mailer => {
        const config = mailConfig();
        return config.driver === 'smtp'
          ? new SmtpMailer(config.smtpUrl, config.from)
          : new LogMailer(process.env.NODE_ENV !== 'production');
      },
    },
  ],
  exports: [Mailer],
})
export class MailModule {}
