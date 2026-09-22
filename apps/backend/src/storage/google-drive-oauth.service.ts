import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { google } from 'googleapis';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfig } from '../config/env';
import { APP_CONFIG } from '../config/config.module';
import { encryptCredential, decryptCredential } from '../crypto/credentialCipher';
import { signOAuthState, verifyOAuthState } from '../domain/oauthState';

@Injectable()
export class GoogleDriveOAuthService {
  private readonly prisma: PrismaService;
  private readonly config: AppConfig;
  private readonly logger = new Logger(GoogleDriveOAuthService.name);
  private readonly consumedNonces = new Set<string>();

  constructor(
    prisma: PrismaService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.prisma = prisma;
    this.config = config;
  }

  isConfigured(): boolean {
    return !!(this.config.googleDriveClientId && this.config.googleDriveClientSecret);
  }

  private getOAuthClient() {
    if (!this.isConfigured()) {
      throw new BadRequestException('Google Drive is currently unavailable.');
    }
    return new google.auth.OAuth2(
      this.config.googleDriveClientId!,
      this.config.googleDriveClientSecret!,
      this.config.googleDriveRedirectUri ?? undefined,
    );
  }

  /**
   * Generates a cryptographically strong, HMAC-signed OAuth state bound to userId with 10-minute expiry.
   */
  signOAuthState(userId: string): string {
    return signOAuthState(userId, this.config.accessTokenSecret);
  }

  /**
   * Validates state signature, expiration, and enforces single-use replay protection.
   */
  verifyOAuthState(state: string): string {
    try {
      return verifyOAuthState(state, this.config.accessTokenSecret, this.consumedNonces);
    } catch (err: any) {
      throw new BadRequestException(err?.message || 'Invalid OAuth state');
    }
  }

  async getStatus(userId: string) {
    const configured = this.isConfigured();
    const connection = await this.prisma.googleDriveConnection.findUnique({ where: { userId } });
    const settings = await this.prisma.userSettings.findUnique({ where: { userId } });

    const connected = !!(connection && !connection.revokedAt);
    const folderId = connection?.driveFolderId ?? null;
    const folderUrl = folderId ? `https://drive.google.com/drive/folders/${folderId}` : null;

    return {
      configured,
      connected,
      revoked: !!(connection && connection.revokedAt),
      folderId,
      folderUrl,
      provider: settings?.attachmentStorageProvider ?? 'MANAGED',
    };
  }

  generateConnectUrl(userId: string): { authUrl: string } {
    const oauth2Client = this.getOAuthClient();
    const state = this.signOAuthState(userId);

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/userinfo.profile',
        'https://www.googleapis.com/auth/userinfo.email',
      ],
      state,
    });

    return { authUrl };
  }

  async handleCallback(code: string, state: string): Promise<{ userId: string }> {
    const userId = this.verifyOAuthState(state);
    const oauth2Client = this.getOAuthClient();

    let tokens;
    try {
      const res = await oauth2Client.getToken(code);
      tokens = res.tokens;
    } catch (err) {
      this.logger.error(`Failed to exchange authorization code for Google Drive: ${String(err)}`);
      throw new BadRequestException('Google authorization failed. Please try again.');
    }

    if (!tokens.access_token) {
      throw new BadRequestException('No access token received from Google');
    }

    oauth2Client.setCredentials(tokens);

    let googleAccountSubject = 'unknown';
    let googleEmail: string | null = null;
    try {
      const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
      const userInfo = await oauth2.userinfo.get();
      googleAccountSubject = userInfo.data.id || 'unknown';
      googleEmail = userInfo.data.email || null;
    } catch {
      // Best-effort userinfo
    }

    const encryptedAccessToken = encryptCredential(tokens.access_token);
    const encryptedRefreshToken = encryptCredential(tokens.refresh_token || tokens.access_token);

    // Locate or create dedicated "Pookie Chat" folder
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    let folderId: string;
    try {
      const query = "name = 'Pookie Chat' and mimeType = 'application/vnd.google-apps.folder' and trashed = false";
      const existing = await drive.files.list({ q: query, fields: 'files(id, name)' });
      const files = existing.data.files;
      const firstFile = files?.[0];
      if (firstFile?.id) {
        folderId = firstFile.id;
      } else {
        const created = await drive.files.create({
          requestBody: {
            name: 'Pookie Chat',
            mimeType: 'application/vnd.google-apps.folder',
          },
          fields: 'id',
        });
        if (!created.data.id) throw new Error('Could not create Pookie Chat folder in Google Drive');
        folderId = created.data.id;
      }
    } catch (err) {
      this.logger.error(`Error resolving Pookie Chat Drive folder: ${String(err)}`);
      throw new BadRequestException('Failed to set up Pookie Chat folder in your Google Drive');
    }

    const expiryDate = tokens.expiry_date
      ? new Date(tokens.expiry_date)
      : new Date(Date.now() + 3600 * 1000);

    await this.prisma.googleDriveConnection.upsert({
      where: { userId },
      create: {
        userId,
        googleAccountSubject,
        googleEmail,
        encryptedAccessToken,
        encryptedRefreshToken,
        accessTokenExpiresAt: expiryDate,
        driveFolderId: folderId,
        connectedAt: new Date(),
        revokedAt: null,
      },
      update: {
        googleAccountSubject,
        googleEmail,
        encryptedAccessToken,
        encryptedRefreshToken,
        accessTokenExpiresAt: expiryDate,
        driveFolderId: folderId,
        revokedAt: null,
      },
    });

    // Update user's preference to GOOGLE_DRIVE
    await this.prisma.userSettings.upsert({
      where: { userId },
      create: { userId, attachmentStorageProvider: 'GOOGLE_DRIVE' },
      update: { attachmentStorageProvider: 'GOOGLE_DRIVE' },
    });

    return { userId };
  }

  async disconnect(userId: string): Promise<void> {
    const connection = await this.prisma.googleDriveConnection.findUnique({ where: { userId } });
    if (connection) {
      try {
        const token = decryptCredential(connection.encryptedAccessToken);
        const oauth2Client = this.getOAuthClient();
        await oauth2Client.revokeToken(token);
      } catch {
        // Best-effort token revocation
      }
      await this.prisma.googleDriveConnection.delete({ where: { userId } });
    }

    await this.prisma.userSettings.upsert({
      where: { userId },
      create: { userId, attachmentStorageProvider: 'MANAGED' },
      update: { attachmentStorageProvider: 'MANAGED' },
    });
  }
}
