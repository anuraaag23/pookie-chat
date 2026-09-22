export interface AttachmentStorageProvider {
  readonly provider: 'MANAGED' | 'GOOGLE_DRIVE';
  upload(encryptedBytes: Buffer, filename: string, userId: string): Promise<string>;
  download(driveFileId: string, uploaderId: string): Promise<Buffer>;
  delete(driveFileId: string, uploaderId: string): Promise<void>;
}
