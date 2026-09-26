import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ManagedStorageProvider } from '../storage/managed-storage.provider';
import { UserDriveStorageProvider } from '../storage/user-drive-storage.provider';

const MAX_ENCRYPTED_SIZE_BYTES = 25 * 1024 * 1024; // 25MB — a starting limit, not a claim about what Drive/the plan supports
const ALLOWED_MIME_HINTS = new Set(['image', 'file']);

// An upload that's never linked to a message (client crashed/closed the
// tab between the upload finishing and the send() call that links it —
// see Attachment.messageId's schema comment, which already documented
// this cleanup as existing before it actually did) sits with
// messageId: null forever otherwise: download() already refuses to
// serve it to anyone (no message means no conversation to check
// membership against), so it isn't a confidentiality problem, but it is
// an indefinite, invisible Drive-storage and DB-row leak with no
// operator-visible signal that it's happening. An hour is generous
// relative to how quickly a real send() follows a real upload (seconds),
// so this only ever catches genuine abandonment, never a slow client.
const ORPHANED_ATTACHMENT_MAX_AGE_MS = 60 * 60 * 1000;
const ORPHAN_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

@Injectable()
export class AttachmentsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AttachmentsService.name);
  private orphanSweepTimer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly managedProvider: ManagedStorageProvider,
    private readonly userDriveProvider: UserDriveStorageProvider,
  ) {}

  private getStorageProvider(provider: 'MANAGED' | 'GOOGLE_DRIVE') {
    return provider === 'GOOGLE_DRIVE' ? this.userDriveProvider : this.managedProvider;
  }

  private async resolveUserStorageProvider(userId: string): Promise<'MANAGED' | 'GOOGLE_DRIVE'> {
    const settings = await this.prisma.userSettings.findUnique({ where: { userId } });
    if (settings?.attachmentStorageProvider === 'GOOGLE_DRIVE') {
      const conn = await this.prisma.googleDriveConnection.findUnique({ where: { userId } });
      if (conn && !conn.revokedAt) {
        return 'GOOGLE_DRIVE';
      }
    }
    return 'MANAGED';
  }

  onModuleInit() {
    this.orphanSweepTimer = setInterval(() => {
      this.cleanupOrphanedAttachments().catch((err) => this.logger.error(`Orphaned-attachment sweep failed: ${String(err)}`));
    }, ORPHAN_SWEEP_INTERVAL_MS);
    // Same reasoning as MessagesService's expiry sweep — never keeps the
    // process (or a test harness) alive on its own.
    this.orphanSweepTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.orphanSweepTimer) clearInterval(this.orphanSweepTimer);
  }

  /**
   * Deletes any attachment still unlinked (messageId: null) after
   * ORPHANED_ATTACHMENT_MAX_AGE_MS — both the Drive blob and the DB row.
   * Best-effort on the Drive side, same as purgeDriveFilesForConversation
   * and deleteForMessage: a Drive failure here must never block the DB
   * row from being cleaned up, and "already gone" is success, not an
   * error worth logging.
   */
  async cleanupOrphanedAttachments(): Promise<number> {
    const cutoff = new Date(Date.now() - ORPHANED_ATTACHMENT_MAX_AGE_MS);
    const orphaned = await this.prisma.attachment.findMany({
      where: { messageId: null, uploadedAt: { lte: cutoff } },
      select: { id: true, driveFileId: true, storageProvider: true, uploaderId: true },
    });
    if (orphaned.length === 0) return 0;
    for (const a of orphaned) {
      try {
        await this.getStorageProvider(a.storageProvider).delete(a.driveFileId, a.uploaderId);
      } catch (err) {
        this.logger.warn(`Drive cleanup failed for orphaned attachment ${a.id} (file ${a.driveFileId}): ${String(err)}`);
      }
      // Deleted individually, not deleteMany: an attachment linked to a
      // message between the findMany above and this delete (a real send()
      // landing mid-sweep) must not be removed out from under it —
      // deleteMany's WHERE would re-evaluate at execution time in most
      // DBs, but scoping each delete to the specific id already read
      // makes the race impossible to hit regardless of DB-specific
      // semantics.
      await this.prisma.attachment.deleteMany({ where: { id: a.id, messageId: null } });
    }
    return orphaned.length;
  }

  async upload(userId: string, conversationId: string, encryptedBytes: Buffer, mimeTypeHint: string, originalSize: number) {
    if (!ALLOWED_MIME_HINTS.has(mimeTypeHint)) {
      throw new BadRequestException('Unsupported attachment type');
    }
    if (encryptedBytes.length > MAX_ENCRYPTED_SIZE_BYTES) {
      throw new BadRequestException('File too large');
    }
    const convo = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!convo || (convo.userAId !== userId && convo.userBId !== userId)) throw new ForbiddenException();
    if (convo.status !== 'ACTIVE') throw new ForbiddenException('Conversation not available');
    if (convo.expiresAt && convo.expiresAt.getTime() <= Date.now()) throw new ForbiddenException('Conversation has expired');

    const storageProvider = await this.resolveUserStorageProvider(userId);
    // Random filename — never the original. EXIF/metadata stripping
    // happens client-side before the file is ever encrypted (the backend
    // never sees plaintext bytes to strip metadata from even if it wanted
    // to — see docs/00-ARCHITECTURE.md on image privacy).
    const randomFilename = randomUUID();
    const provider = this.getStorageProvider(storageProvider);
    const driveFileId = await provider.upload(encryptedBytes, randomFilename, userId);

    const attachment = await this.prisma.attachment.create({
      data: {
        uploaderId: userId,
        conversationId,
        driveFileId,
        storageProvider,
        mimeTypeHint,
        originalSize,
        encryptedSize: encryptedBytes.length,
      },
    });
    return { attachmentId: attachment.id };
  }

  /**
   * Called once the message referencing this attachment has been created, so
   * orphaned uploads (crash before send) don't silently masquerade as
   * attached content.
   *
   * Validates that the caller actually uploaded this attachment, that it
   * belongs to the conversation the message is being sent in, and that it
   * isn't already linked to a different message — otherwise a client could
   * supply an attachmentId it doesn't own and re-point someone else's
   * already-uploaded file at a message in an unrelated conversation. Real
   * exploitability was low even before this check (attachment IDs are
   * unguessable UUIDs, never sent in plaintext — see the encrypted
   * AttachmentPayload in engine.ts), but there's no reason not to close it.
   *
   * `encryptedDek` is optional and nullable in the schema by design: the
   * DEK a client actually needs to decrypt the file already travels
   * end-to-end inside the message's own ratchet-encrypted ciphertext (see
   * apps/web/app/chat/[conversationId]/page.tsx's sendFile, which embeds
   * `dek` directly in the JSON payload it ratchet-encrypts) — this
   * parameter exists for a client that additionally wants the server to
   * hold a copy for some other retrieval path, not because one is
   * required for the core feature to work.
   *
   * THE FIX (found during the final pre-runtime audit's API-contract
   * inventory): this used to be a required `Buffer` parameter, and
   * messages.service.ts's send() only ever called this method at all
   * when `dto.encryptedDek` was truthy. The real frontend's sendFile()
   * has never once sent that field — grepped the entire apps/web tree,
   * zero references anywhere — only `attachmentId`. That meant every
   * attachment sent through the actual app failed this check silently,
   * `linkToMessage` was never called, `messageId` stayed null forever,
   * and the attachment was swept away as "orphaned" an hour later,
   * undownloadable by anyone (including the sender) the entire time —
   * the real attachment-sending feature was completely non-functional,
   * despite every harness check passing, because every harness
   * attachment scenario seeded the `attachments` table directly via SQL
   * and never actually drove a real /api/messages POST with an
   * attachmentId the way sendFile() really does (fixed in server.mjs
   * alongside this).
   */
  async linkToMessage(attachmentId: string, messageId: string, conversationId: string, uploaderId: string, encryptedDek: Buffer | null) {
    const attachment = await this.prisma.attachment.findUnique({ where: { id: attachmentId } });
    if (!attachment) throw new NotFoundException('Attachment not found');
    if (attachment.uploaderId !== uploaderId) throw new ForbiddenException();
    if (attachment.conversationId !== conversationId) throw new ForbiddenException();
    if (attachment.messageId !== null) throw new ForbiddenException('Attachment already linked to a message');
    await this.prisma.attachment.update({ where: { id: attachmentId }, data: { messageId, encryptedDek } });
  }

  async download(userId: string, attachmentId: string) {
    const attachment = await this.prisma.attachment.findUnique({ where: { id: attachmentId }, include: { message: { include: { conversation: true } } } });
    if (!attachment) throw new NotFoundException('Not found');
    const convo = attachment.message?.conversation;
    if (!convo || (convo.userAId !== userId && convo.userBId !== userId)) throw new ForbiddenException();
    if (convo.expiresAt && convo.expiresAt.getTime() <= Date.now()) throw new NotFoundException('Not found');
    // Defense in depth alongside deleteForMessage below: even if an
    // attachment row somehow outlived its message's deletion, never
    // serve the file for a message that's been deleted or has expired —
    // a still-downloadable image is exactly as much a break of "this
    // message is gone" as recoverable ciphertext would be.
    if (attachment.message?.deletedAt) throw new NotFoundException('Not found');

    const provider = this.getStorageProvider(attachment.storageProvider);
    const bytes = await provider.download(attachment.driveFileId, attachment.uploaderId);
    return { bytes, encryptedDek: attachment.encryptedDek?.toString('base64') ?? null, mimeTypeHint: attachment.mimeTypeHint };
  }

  /**
   * Called by ConversationsService.burn(), before it removes the DB
   * rows (in its own atomic transaction — deliberately not here: a
   * network call to Drive has no place inside a DB transaction, and the
   * DB-side deletion is the guarantee that actually matters, so it must
   * not be gated on Drive's availability). This method only ever touches
   * Drive, never the database — it returns the driveFileIds it
   * attempted so the caller's own DB cleanup stays the single source of
   * truth for which rows existed.
   *
   * Best-effort by design: a Drive failure here must never block burn
   * from completing. docs/01-THREAT-MODEL.md §4 is explicit that burn
   * removes "your own copies and, where technically possible, the
   * server's queued copy" — Drive cleanup is exactly the "where
   * technically possible" part, not the core guarantee (which is the DB
   * ciphertext deletion). Each file is deleted independently so one
   * failure doesn't stop the rest, and "already gone" (e.g. a retried
   * burn attempt) is treated as success, not logged as an error.
   */
  async purgeDriveFilesForConversation(conversationId: string): Promise<void> {
    const attachments = await this.prisma.attachment.findMany({
      where: { conversationId },
      select: { id: true, driveFileId: true, storageProvider: true, uploaderId: true },
    });
    await Promise.all(
      attachments.map(async (a) => {
        try {
          await this.getStorageProvider(a.storageProvider).delete(a.driveFileId, a.uploaderId);
        } catch (err) {
          this.logger.warn(`Drive cleanup failed for attachment ${a.id} (file ${a.driveFileId}) during burn: ${String(err)}`);
        }
      }),
    );
  }

  /**
   * Called by MessagesService whenever a message is deleted or expires
   * (deleteMessage, cleanupExpiredMessages) — found missing entirely
   * while auditing the attachment flow end to end: deleting a message
   * only ever wiped its own ciphertext/nonce columns, never touched
   * Attachment at all. Attachment.messageId does have onDelete: Cascade,
   * but that's a foreign-key cascade — it only fires when the Message
   * row is actually deleted from the table, and message "deletion" here
   * is a soft delete (deletedAt set, content wiped, row kept as a sync
   * tombstone). The cascade never ran, so the attachment's DB row — and
   * the still-fully-downloadable Drive file it points to — outlived
   * every deletion path a message itself has: explicit deletion,
   * disappearing-timer expiry, all of it. The message's own text became
   * unrecoverable; a photo attached to it did not.
   */
  async deleteForMessage(messageId: string): Promise<void> {
    const attachment = await this.prisma.attachment.findFirst({
      where: { messageId },
      select: { id: true, driveFileId: true, storageProvider: true, uploaderId: true },
    });
    if (!attachment) return;
    try {
      await this.getStorageProvider(attachment.storageProvider).delete(attachment.driveFileId, attachment.uploaderId);
    } catch (err) {
      this.logger.warn(`Drive cleanup failed for attachment ${attachment.id} (file ${attachment.driveFileId}) on message delete: ${String(err)}`);
    }
    // Hard-deleted, not soft-deleted like Message: nothing ever "syncs"
    // an attachment the way messages sync to a client — a client only
    // ever fetches one by an id it already has from the message it was
    // linked to, and that message's own sync tombstone (deleted: true)
    // is what tells the client to stop referencing it. There's no
    // reason to keep a row around for that.
    await this.prisma.attachment.delete({ where: { id: attachment.id } });
  }
}
