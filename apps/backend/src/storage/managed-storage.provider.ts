import { Injectable, Logger } from '@nestjs/common';
import { AttachmentStorageProvider } from './storage-provider.interface';
import { GoogleDriveService } from '../attachments/google-drive.service';
import { LocalAttachmentStore } from './local-attachment-store';

/**
 * Default managed storage provider: uses Google Drive service account when configured,
 * with automatic fallback to zero-knowledge local encrypted storage on disk.
 *
 * All stored payloads are ALREADY end-to-end encrypted on the client device
 * with AES-256-GCM before reaching the server. The server never possesses
 * the decryption key, preserving strict zero-knowledge confidentiality.
 */
@Injectable()
export class ManagedStorageProvider implements AttachmentStorageProvider {
  readonly provider = 'MANAGED' as const;
  private readonly logger = new Logger(ManagedStorageProvider.name);
  private readonly drive: GoogleDriveService;
  private readonly localStore: LocalAttachmentStore;

  constructor(drive: GoogleDriveService) {
    this.drive = drive;
    this.localStore = new LocalAttachmentStore();
  }

  async upload(encryptedBytes: Buffer, filename: string): Promise<string> {
    if (this.drive.isConfigured()) {
      try {
        return await this.drive.uploadEncrypted(encryptedBytes, filename);
      } catch (err) {
        this.logger.warn(`Google Drive upload failed, falling back to local encrypted storage: ${String(err)}`);
      }
    }

    const fileId = await this.localStore.save(encryptedBytes, filename);
    this.logger.log(`Stored encrypted attachment locally: ${fileId} (${encryptedBytes.length} bytes)`);
    return fileId;
  }

  async download(driveFileId: string): Promise<Buffer> {
    const localBytes = await this.localStore.read(driveFileId);
    if (localBytes) {
      return localBytes;
    }

    return this.drive.downloadEncrypted(driveFileId);
  }

  async delete(driveFileId: string): Promise<void> {
    const deleted = await this.localStore.remove(driveFileId);
    if (deleted) {
      return;
    }

    return this.drive.deleteFile(driveFileId);
  }
}
