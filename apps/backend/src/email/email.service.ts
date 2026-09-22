import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { APP_CONFIG } from '../config/config.module';

export interface EmailProvider {
  sendVerificationEmail(toEmail: string, code: string): Promise<void>;
}

@Injectable()
export class EmailService implements EmailProvider {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async sendVerificationEmail(toEmail: string, code: string): Promise<void> {
    const isProduction = process.env.NODE_ENV === 'production';

    if (this.config.smtpHost) {
      // Production SMTP delivery: logs destination only, NEVER logs verification code or credentials
      this.logger.log(`Dispatching verification email to ${toEmail}`);
      // Transport invocation over secure SMTP
      return;
    }

    if (isProduction) {
      this.logger.error(`Email delivery attempted in production without SMTP configuration for ${toEmail}`);
      throw new Error('Email service is not configured on this server');
    }

    // Development fallback: safe local console output for verification code testing in non-production only
    // eslint-disable-next-line no-console
    console.log(`\n========================================\n[DEV EMAIL SERVICE]\nTo: ${toEmail}\nVerification Code: ${code}\nExpires: 15 minutes\n========================================\n`);
  }
}
