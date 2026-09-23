import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConnectionRegistryService } from '../realtime/connection-registry.service';
import { AttachmentsService } from '../attachments/attachments.service';

@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ConnectionRegistryService,
    private readonly attachments: AttachmentsService,
  ) {}

  private async getOwnedConversation(userId: string, conversationId: string) {
    const convo = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        userA: { select: { id: true, username: true, displayName: true } },
        userB: { select: { id: true, username: true, displayName: true } },
      },
    });
    if (!convo || (convo.userAId !== userId && convo.userBId !== userId)) throw new NotFoundException('Not found');
    return convo;
  }

  async list(userId: string) {
    const convos = await this.prisma.conversation.findMany({
      where: { OR: [{ userAId: userId }, { userBId: userId }], status: { not: 'DELETED' } },
      include: {
        userA: { select: { id: true, username: true, displayName: true } },
        userB: { select: { id: true, username: true, displayName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return convos.map((c) => {
      const otherUser = c.userAId === userId ? c.userB : c.userA;
      return {
        id: c.id,
        userAId: c.userAId,
        userBId: c.userBId,
        status: c.status,
        disappearingTimerSeconds: c.disappearingTimerSeconds,
        disappearingTrigger: c.disappearingTrigger,
        sessionEpoch: c.sessionEpoch,
        createdAt: c.createdAt,
        otherUser: {
          id: otherUser.id,
          username: otherUser.username,
          displayName: otherUser.displayName,
        },
      };
    });
  }

  /**
   * A single conversation's current lifecycle state — deliberately the
   * one read path that does NOT filter out DELETED (unlike list()
   * above), because its whole purpose is to let a past participant find
   * out their conversation was burned. Ownership is still enforced
   * (getOwnedConversation), so this never leaks state to anyone who
   * wasn't actually part of the pair.
   *
   * Called by the client at bootstrap and on every reconnect, before it
   * trusts a locally cached ratchet session — see sessionStore.ts's
   * isSessionStale and app/chat/[conversationId]/page.tsx's
   * ensureFreshSession. This is the offline-safe half of burn
   * propagation: a device that was offline when the burn (and any
   * re-pair after it) happened learns about it here, on its own next
   * check, rather than depending on having been online to receive the
   * WebSocket broadcast burn() also sends.
   */
  async getStatus(userId: string, conversationId: string) {
    const convo = await this.getOwnedConversation(userId, conversationId);
    const otherUser = convo.userAId === userId ? convo.userB : convo.userA;
    return {
      id: convo.id,
      status: convo.status,
      sessionEpoch: convo.sessionEpoch,
      otherUser: {
        id: otherUser.id,
        username: otherUser.username,
        displayName: otherUser.displayName,
      },
    };
  }

  async block(userId: string, conversationId: string) {
    const convo = await this.getOwnedConversation(userId, conversationId);
    const status = convo.userAId === userId ? 'BLOCKED_BY_A' : 'BLOCKED_BY_B';
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { status } });
  }

  async unblock(userId: string, conversationId: string) {
    const convo = await this.getOwnedConversation(userId, conversationId);
    // Only the person who initiated the block can lift it — the other
    // party being blocked has no way to un-block themselves.
    const blockedByThisUser = (convo.userAId === userId && convo.status === 'BLOCKED_BY_A') || (convo.userBId === userId && convo.status === 'BLOCKED_BY_B');
    if (!blockedByThisUser) throw new ForbiddenException('Only the user who blocked can unblock');
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { status: 'ACTIVE' } });
  }

  /**
   * Burns the conversation for BOTH parties — not just "this user's
   * copy". With a 1:1-only design there is no separate per-user copy of
   * a message row to begin with (docs/02-DATABASE-SCHEMA.md), so
   * burning at the conversation level is the only form burn can
   * actually take server-side; docs/01-THREAT-MODEL.md §4 is explicit
   * that this is the server's *queued* copy, never a reach into
   * anything the other party already decrypted, screenshotted, or
   * exported on their own device.
   *
   * Three things a caller-only burn used to miss, all fixed here:
   *
   *  1. ATOMICITY. Every DB mutation below (attachment rows, messages,
   *     the pending handshake, the status flip) now runs in one
   *     transaction. Previously these were separate calls — a crash or
   *     dropped connection between them could leave a conversation with
   *     messages already gone but status still ACTIVE (so it would keep
   *     showing up, empty, instead of being recognized as burned), or
   *     status already DELETED but messages still present (so a client
   *     that bypassed the status check could still read old ciphertext).
   *
   *  2. PROPAGATION. Burning previously updated the database and
   *     nothing else — the other party had no way to learn about it
   *     short of guessing from an unexplained empty conversation. Now:
   *     an online peer gets an immediate 'conversation_burned' push
   *     (ConnectionRegistryService.pushToUser); an offline peer learns
   *     it from getStatus() the next time they check (bootstrap/reconnect
   *     on their end), which — since the row's status is DELETED and
   *     sessionEpoch does not advance from burning alone (only a
   *     subsequent successful re-pair advances it) — is exactly what
   *     that check is for.
   *
   *  3. ATTACHMENTS. Drive-side encrypted files were never cleaned up —
   *     the DB attachment rows would cascade away with their message,
   *     but the actual blobs would sit in the Shared Drive forever.
   *     purgeDriveFilesForConversation() (best-effort; see its own doc
   *     comment) now runs first, while the attachment rows still exist
   *     to enumerate.
   */
  async burn(userId: string, conversationId: string) {
    const convo = await this.getOwnedConversation(userId, conversationId);
    const otherUserId = convo.userAId === userId ? convo.userBId : convo.userAId;

    // Network call to an external service — deliberately outside the DB
    // transaction below, and deliberately before it, while the
    // attachment rows it needs to enumerate still exist.
    await this.attachments.purgeDriveFilesForConversation(conversationId);

    await this.prisma.$transaction([
      // Explicit, not just relying on Message's onDelete: Cascade —
      // that cascade only reaches attachments already linked to a
      // message. An upload that was never linked to a message (crash
      // before send) has no message to cascade from, so it needs its
      // own delete here to actually be gone.
      this.prisma.attachment.deleteMany({ where: { conversationId } }),
      this.prisma.message.deleteMany({ where: { conversationId } }),
      // pending_handshakes is keyed 1:1 on conversationId, so this can
      // only ever remove a handshake belonging to *this* conversation —
      // never one for either party's other conversations. Deleting it
      // here (rather than leaving it for the next redeem() to overwrite)
      // closes the "old pending handshake recreates the old
      // conversation" case: with it gone, HandshakeService.fetch() has
      // nothing to hand out until a genuinely new pairing stores a new
      // one, so there is no window where stale handshake material for
      // the burned session is reachable.
      this.prisma.pendingHandshake.deleteMany({ where: { conversationId } }),
      this.prisma.conversation.update({ where: { id: conversationId }, data: { status: 'DELETED' } }),
    ]);

    // Best-effort, deliberately after the transaction commits: an
    // undelivered push is not a correctness problem the way a partial
    // DB write would be, since getStatus() is the durable backstop the
    // other party's client checks on its own regardless of whether this
    // arrives.
    this.registry.pushToUser(otherUserId, 'conversation_burned', { conversationId });
  }

  async setDisappearingTimer(userId: string, conversationId: string, timerSeconds: number | null, trigger: 'SENT' | 'DELIVERED' | 'READ') {
    await this.getOwnedConversation(userId, conversationId);
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { disappearingTimerSeconds: timerSeconds, disappearingTrigger: timerSeconds ? trigger : null },
    });
  }
}
