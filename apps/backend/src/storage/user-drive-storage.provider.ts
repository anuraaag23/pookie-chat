import { Inject, Injectable, Logger, BadRequestException } from '@nestjs/common';
import { google } from 'googleapis';
import { Readable } from 'node:stream';
import { AttachmentStorageProvider } from './storage-provider.interface';
import { PrismaService } from '../prisma/prisma.service';
import { APP_CONFIG } from '../config/config.module';
import { AppConfig } from '../config/env';
import { decryptCredential, encryptCredential } from '../crypto/credentialCipher';

@Injectable()
export class UserDriveStorageProvider implements AttachmentStorageProvider {
  readonly provider = 'GOOGLE_DRIVE' as const;
  private readonly logger = new Logger(UserDriveStorageProvider.name);
  private readonly prisma: PrismaService;
  private readonly config: AppConfig;

  constructor(
    prisma: PrismaService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.prisma = prisma;
    this.config = config;
  }

  private async getAuthorizedDrive(userId: string) {
    if (!this.config.googleDriveClientId || !this.config.googleDriveClientSecret) {
      throw new BadRequestException('Google Drive is not configured on this server');
    }

    const connection = await this.prisma.googleDriveConnection.findUnique({ where: { userId } });
    if (!connection || connection.revokedAt) {
      throw new BadRequestException('Google Drive connection expired or not connected. Reconnect to continue using Google Drive storage.');
    }

    const oauth2Client = new google.auth.OAuth2(
      this.config.googleDriveClientId,
      this.config.googleDriveClientSecret,
      this.config.googleDriveRedirectUri ?? undefined,
    );

    let accessToken = decryptCredential(connection.encryptedAccessToken);
    const refreshToken = decryptCredential(connection.encryptedRefreshToken);

    oauth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken,
    });

    // Check if access token is expired or expiring within 5 minutes
    const isExpiring = connection.accessTokenExpiresAt.getTime() - Date.now() < 5 * 60 * 1000;
    if (isExpiring) {
      try {
        const { credentials } = await oauth2Client.refreshAccessToken();
        accessToken = credentials.access_token || accessToken;
        const newExpiry = credentials.expiry_date
          ? new Date(credentials.expiry_date)
          : new Date(Date.now() + 3600 * 1000);

        const encryptedAccessToken = encryptCredential(accessToken);
        const encryptedRefreshToken = credentials.refresh_token
          ? encryptCredential(credentials.refresh_token)
          : connection.encryptedRefreshToken;

        await this.prisma.googleDriveConnection.update({
          where: { id: connection.id },
          data: {
            encryptedAccessToken,
            encryptedRefreshToken,
            accessTokenExpiresAt: newExpiry,
          },
        });
      } catch (err) {
        this.logger.warn(`Google Drive token refresh failed for user ${userId}: ${String(err)}`);
        // If refresh fails due to revocation / invalid grant, record revokedAt
        await this.prisma.googleDriveConnection.update({
          where: { id: connection.id },
          data: { revokedAt: new Date() },
        });
        throw new BadRequestException('Google Drive connection expired. Reconnect to continue using Google Drive storage.');
      }
    }

    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    return { drive, folderId: connection.driveFolderId };
  }

  async upload(encryptedBytes: Buffer, filename: string, userId: string): Promise<string> {
    const { drive, folderId } = await this.getAuthorizedDrive(userId);

    const res = await drive.files.create({
      requestBody: {
        name: filename,
        parents: [folderId],
      },
      media: {
        mimeType: 'application/octet-stream',
        body: Readable.from(encryptedBytes),
      },
      fields: 'id',
    });

    if (!res.data.id) {
      throw new Error('Google Drive upload did not return a file id');
    }
    return res.data.id;
  }

  async download(driveFileId: string, uploaderId: string): Promise<Buffer> {
    const { drive } = await this.getAuthorizedDrive(uploaderId);

    const res = await drive.files.get(
      { fileId: driveFileId, alt: 'media' },
      { responseType: 'arraybuffer' },
    );

    return Buffer.from(res.data as ArrayBuffer);
  }

  async delete(driveFileId: string, uploaderId: string): Promise<void> {
    const { drive } = await this.getAuthorizedDrive(uploaderId);
    await drive.files.delete({ fileId: driveFileId });
  }
}
