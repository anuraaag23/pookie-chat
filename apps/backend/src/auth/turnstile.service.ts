import { Injectable, BadRequestException, Logger, Inject } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { APP_CONFIG } from '../config/config.module';

export interface TurnstileVerificationResult {
  success: boolean;
  bypassed?: boolean;
}

@Injectable()
export class TurnstileService {
  private readonly logger = new Logger(TurnstileService.name);
  private readonly config: AppConfig;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.config = config;
  }

  /**
   * Authoritative server-side verification of Cloudflare Turnstile token.
   * Calls https://challenges.cloudflare.com/turnstile/v0/siteverify.
   *
   * Never logs secrets or tokens.
   * Returns safe, generic exceptions matching Pookie Chat error conventions.
   */
  async verifyToken(token?: string | null, remoteIp?: string): Promise<TurnstileVerificationResult> {
    const secretKey = this.config.turnstileSecretKey;
    const isProduction = process.env.NODE_ENV === 'production';

    // Development / non-production: allow bypass if unconfigured so local testing isn't blocked
    if (!secretKey) {
      if (!isProduction) {
        this.logger.warn('TURNSTILE_SECRET_KEY is not configured. Bypassing Turnstile verification in non-production.');
        return { success: true, bypassed: true };
      }
      this.logger.error('TURNSTILE_SECRET_KEY is not configured in production environment.');
      throw new BadRequestException('Security verification is not configured on this server.');
    }

    if (!token || typeof token !== 'string' || !token.trim()) {
      throw new BadRequestException('Security verification required. Please complete the challenge.');
    }

    try {
      const formData = new URLSearchParams();
      formData.append('secret', secretKey);
      formData.append('response', token.trim());
      if (remoteIp) {
        formData.append('remoteip', remoteIp);
      }

      const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData.toString(),
      });

      if (!res.ok) {
        this.logger.warn(`Turnstile siteverify responded with HTTP status ${res.status}`);
        throw new BadRequestException('Security verification unavailable. Please try again in a few moments.');
      }

      const result = (await res.json()) as { success: boolean; 'error-codes'?: string[] };

      if (!result.success) {
        const errorCodes = result['error-codes'] ?? [];
        if (errorCodes.includes('timeout-or-duplicate')) {
          throw new BadRequestException('Security verification expired. Please complete the challenge again.');
        }
        throw new BadRequestException('Security verification failed. Please try again.');
      }

      return { success: true };
    } catch (err) {
      if (err instanceof BadRequestException) {
        throw err;
      }
      this.logger.error('Failed to communicate with Cloudflare Turnstile service', (err as Error)?.message);
      throw new BadRequestException('Security verification unavailable. Please try again in a few moments.');
    }
  }
}
