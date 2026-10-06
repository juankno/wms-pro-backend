import { Logger } from '@nestjs/common';
import { createTransport, Transporter } from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

// Injection token and contract of the configured mail driver.
export abstract class Mailer {
  abstract send(message: MailMessage): Promise<void>;
}

// Development driver: prints the message instead of delivering it.
export class LogMailer extends Mailer {
  private readonly logger = new Logger('Mailer');

  constructor(private readonly includeBody: boolean) {
    super();
  }

  send(message: MailMessage): Promise<void> {
    const body = this.includeBody ? `\n${message.text}` : '';
    this.logger.log(`Mail to ${message.to}: ${message.subject}${body}`);
    return Promise.resolve();
  }
}

export class SmtpMailer extends Mailer {
  private readonly transport: Transporter;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    super();
    this.transport = createTransport(smtpUrl);
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...message });
  }
}
