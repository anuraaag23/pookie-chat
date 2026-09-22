import { Inject, Injectable, Logger } from '@nestjs/common';
import { google } from 'googleapis';
import { Readable } from 'node:stream';
import { APP_CONFIG } from '../config/config.module';
import { AppConfig } from '../config/env';

/**
 * Backend-only Google Drive access. This is the ONLY file in the codebase
 * that talks to Drive — no client ever receives credentials, a Drive
 * file ID that resolves to a public URL, or a way to call Drive directly.
 *
 * HONESTY NOTE: unlike most of this backend, this specific integration
 * has not been run even once, by design of the situation rather than by
 * omission — it requires a real GCP service account and a real Shared
 * Drive, neither of which exist yet. That's a different, stronger kind of
 * "unverified" than the rest of the NestJS layer (which is written and
 * unit-testable in its logic, just not runnable in this network-less
 * sandbox): this code's correctness against the actual Drive API has
 * never been checked at all. Treat it as a first draft to validate
 * against a real account before relying on it, not as tested integration
 * code.
 *
 * Setup this expects (see docs/00-ARCHITECTURE.md §2 and the README):
 *  1. A GCP project with the Drive API enabled.
 *  2. A service account with NO other permissions, granted access to
 *     exactly one Shared Drive created for this app (never a personal
 *     "My Drive").
 *  3. GOOGLE_APPLICATION_CREDENTIALS pointing at that service account's
 *     JSON key, readable only by the backend process — never committed,
 *     never sent to any client.
 *  4. GOOGLE_DRIVE_SHARED_DRIVE_ID set to that Shared Drive's ID.
 *  5. Sharing on that Drive locked down: no link sharing, no "anyone with
 *     the link" — access is entirely mediated by this service account and
 *     this backend's own authorization checks, never Drive's own ACLs.
 */
@Injectable()
export class GoogleDriveService {
  private readonly logger = new Logger(GoogleDriveService.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private get sharedDriveId(): string | null {
    return this.config.googleDriveSharedDriveId;
  }

  private getClient() {
    // Relies on GOOGLE_APPLICATION_CREDENTIALS being set — googleapis'
    // GoogleAuth picks it up automatically; it is never read or passed
    // explicitly here, so there's no code path that could accidentally
    // log or return it.
    const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/drive.file'] });
    return google.drive({ version: 'v3', auth });
  }

  /**
   * Uploads an already-encrypted blob (the caller must never pass
   * plaintext here) and returns Drive's internal file ID — never a
   * shareable link, since link sharing is never enabled on this Drive.
   */
  async uploadEncrypted(encryptedBytes: Buffer, randomFilename: string): Promise<string> {
    if (!this.sharedDriveId) {
      throw new Error('GOOGLE_DRIVE_SHARED_DRIVE_ID is not configured — attachments are unavailable until it is.');
    }
    const drive = this.getClient();
    const res = await drive.files.create({
      requestBody: {
        name: randomFilename, // never the original filename — see docs/00-ARCHITECTURE.md on filename privacy
        parents: [this.sharedDriveId],
      },
      media: { mimeType: 'application/octet-stream', body: Readable.from(encryptedBytes) },
      supportsAllDrives: true,
      fields: 'id',
    });
    if (!res.data.id) throw new Error('Drive upload did not return a file id');
    this.logger.log(`Uploaded encrypted attachment ${res.data.id}`);
    return res.data.id;
  }

  /** Streams the encrypted bytes back — the backend is always the one calling this, then relaying to the authorized recipient; the recipient's browser never talks to Drive directly. */
  async downloadEncrypted(driveFileId: string): Promise<Buffer> {
    const drive = this.getClient();
    const res = await drive.files.get(
      { fileId: driveFileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' },
    );
    return Buffer.from(res.data as ArrayBuffer);
  }

  async deleteFile(driveFileId: string): Promise<void> {
    const drive = this.getClient();
    await drive.files.delete({ fileId: driveFileId, supportsAllDrives: true });
  }
}
