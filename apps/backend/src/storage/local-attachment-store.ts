import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Pure local filesystem store for zero-knowledge encrypted attachment blobs.
 *
 * Security Properties:
 * 1. Payload is ALWAYS pre-encrypted client-side (AES-256-GCM) with client ephemeral keys.
 * 2. The server stores opaque binary blobs and never has access to decryption keys.
 * 3. Filenames are strictly sanitized with path.basename() to prevent path traversal attacks.
 */
export class LocalAttachmentStore {
  private readonly storageDir: string;

  constructor(customDir?: string) {
    this.storageDir = customDir || process.env.ATTACHMENTS_DIR || path.resolve(process.cwd(), 'uploads', 'attachments');
    this.ensureDir();
  }

  ensureDir(): void {
    try {
      if (!fs.existsSync(this.storageDir)) {
        fs.mkdirSync(this.storageDir, { recursive: true });
      }
    } catch {}
  }

  getFilePath(filename: string): string {
    const safeName = path.basename(filename);
    return path.join(this.storageDir, safeName);
  }

  async save(encryptedBytes: Buffer, filename: string): Promise<string> {
    this.ensureDir();
    const safeFilename = path.basename(filename);
    const targetPath = this.getFilePath(safeFilename);
    await fs.promises.writeFile(targetPath, encryptedBytes);
    return `local:${safeFilename}`;
  }

  async read(fileId: string): Promise<Buffer | null> {
    const filename = fileId.startsWith('local:') ? fileId.slice(6) : fileId;
    const filePath = this.getFilePath(filename);
    if (fs.existsSync(filePath)) {
      return fs.promises.readFile(filePath);
    }
    return null;
  }

  async remove(fileId: string): Promise<boolean> {
    const filename = fileId.startsWith('local:') ? fileId.slice(6) : fileId;
    const filePath = this.getFilePath(filename);
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath).catch(() => {});
      return true;
    }
    return false;
  }
}
