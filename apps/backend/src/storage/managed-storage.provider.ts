import { Injectable } from '@nestjs/common';
import { AttachmentStorageProvider } from './storage-provider.interface';
import { GoogleDriveService } from '../attachments/google-drive.service';

/**
 * Default managed storage provider: uses Pookie Chat's backend service account and Shared Drive.
 * Existing attachment behavior is completely preserved.
 */
@Injectable()
export class ManagedStorageProvider implements AttachmentStorageProvider {
  readonly provider = 'MANAGED' as const;
  private readonly drive: GoogleDriveService;

  constructor(drive: GoogleDriveService) {
    this.drive = drive;
  }

  async upload(encryptedBytes: Buffer, filename: string): Promise<string> {
    return this.drive.uploadEncrypted(encryptedBytes, filename);
  }

  async download(driveFileId: string): Promise<Buffer> {
    return this.drive.downloadEncrypted(driveFileId);
  }

  async delete(driveFileId: string): Promise<void> {
    return this.drive.deleteFile(driveFileId);
  }
}
