import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { google } from 'googleapis';
import { AppConfig } from '../config/env';
import { APP_CONFIG } from '../config/config.module';
import { signOAuthState, verifyOAuthState } from '../domain/oauthState';

export interface VerifiedGoogleProfile {
  sub: string;
  email: string;
  name?: string;
}

interface StoredTicket extends VerifiedGoogleProfile {
  expiresAt: number;
}

@Injectable()
export class GoogleAuthService {
  private readonly logger = new Logger(GoogleAuthService.name);
  private readonly consumedNonces = new Set<string>();
  private readonly tickets = new Map<string, StoredTicket>();
  private readonly config: AppConfig;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.config = config;
  }

  isConfigured(): boolean {
    return !!this.config.googleClientId;
  }

  getConfig(): { configured: boolean; clientId: string | null } {
    return {
      configured: this.isConfigured(),
      clientId: this.config.googleClientId ?? null,
    };
  }

  getOAuthClient() {
    if (!this.isConfigured()) {
      throw new BadRequestException('Google authentication is not configured on this server.');
    }
    const redirectUri =
      this.config.googleAuthRedirectUri ?? 'https://pookie-chat-0s89.onrender.com/api/auth/google/callback';
    return new google.auth.OAuth2(
      this.config.googleClientId!,
      this.config.googleClientSecret ?? undefined,
      redirectUri,
    );
  }

  generateAuthUrl(action = 'login', returnTo?: string): { authUrl: string } {
    const oauth2Client = this.getOAuthClient();
    const statePayload = `auth:${action}:${encodeURIComponent(returnTo || '')}`;
    const state = signOAuthState(statePayload, this.config.accessTokenSecret);

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'online',
      scope: ['openid', 'email', 'profile'],
      state,
      prompt: 'select_account',
    });

    return { authUrl };
  }

  async verifyIdToken(idToken: string): Promise<VerifiedGoogleProfile> {
    const oauth2Client = this.getOAuthClient();
    try {
      const ticket = await oauth2Client.verifyIdToken({
        idToken,
        audience: this.config.googleClientId!,
      });
      const payload = ticket.getPayload();
      if (!payload || !payload.email || !payload.sub) {
        throw new BadRequestException('Invalid Google token: missing required email or subject');
      }
      if (!payload.email_verified) {
        throw new BadRequestException('Google email is not verified');
      }
      return {
        sub: payload.sub,
        email: payload.email,
        name: payload.name,
      };
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      this.logger.warn(`Failed to verify Google ID token: ${String(err?.message || err)}`);
      throw new BadRequestException('Invalid or expired Google credential');
    }
  }

  createTicket(profile: VerifiedGoogleProfile): string {
    this.cleanupExpiredTickets();
    const ticketId = randomUUID();
    this.tickets.set(ticketId, {
      ...profile,
      expiresAt: Date.now() + 5 * 60 * 1000, // 5-minute single-use ticket
    });
    return ticketId;
  }

  consumeTicket(ticketId: string): VerifiedGoogleProfile {
    this.cleanupExpiredTickets();
    const ticket = this.tickets.get(ticketId);
    if (!ticket) {
      throw new BadRequestException('Invalid or expired Google authentication ticket. Please try again.');
    }
    this.tickets.delete(ticketId);
    if (Date.now() > ticket.expiresAt) {
      throw new BadRequestException('Google authentication ticket has expired. Please try again.');
    }
    return {
      sub: ticket.sub,
      email: ticket.email,
      name: ticket.name,
    };
  }

  async handleCallback(code: string, state: string): Promise<{ ticket: string; action: string; returnTo?: string }> {
    let action = 'login';
    let returnTo: string | undefined;

    try {
      const stateContent = verifyOAuthState(state, this.config.accessTokenSecret, this.consumedNonces);
      const parts = stateContent.split(':');
      if (parts[1]) action = parts[1];
      if (parts[2]) returnTo = decodeURIComponent(parts[2]);
    } catch (err: any) {
      this.logger.warn(`Google OAuth state verification failed: ${err?.message}`);
      throw new BadRequestException(err?.message || 'Invalid or expired OAuth state');
    }

    const oauth2Client = this.getOAuthClient();
    let idToken: string | undefined;
    try {
      const { tokens } = await oauth2Client.getToken(code);
      idToken = tokens.id_token ?? undefined;
    } catch (err: any) {
      this.logger.warn(`Failed to exchange Google OAuth code: ${err?.message}`);
      throw new BadRequestException('Failed to exchange authorization code with Google');
    }

    if (!idToken) {
      throw new BadRequestException('No ID token returned by Google');
    }

    const profile = await this.verifyIdToken(idToken);
    const ticket = this.createTicket(profile);
    return { ticket, action, returnTo };
  }

  private cleanupExpiredTickets() {
    const now = Date.now();
    for (const [id, ticket] of this.tickets.entries()) {
      if (now > ticket.expiresAt) {
        this.tickets.delete(id);
      }
    }
  }
}
