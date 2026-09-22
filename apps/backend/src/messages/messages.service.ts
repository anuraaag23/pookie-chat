import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ConnectionRegistryService } from '../realtime/connection-registry.service';
import { nextSequenceNumber, higherCounterValue, resolveDisappearTrigger, computeDisappearAt } from '../domain/messageState';
import { isStaleEpoch } from '../domain/sessionEpoch';
import { SendMessageDto } from './dto/messages.dto';
import { AttachmentsService } from '../attachments/attachments.service';

// Bounds the retry loop in createMessageWithRetry below. Sized generously
// relative to how many genuinely concurrent senders a single 1:1
// conversation can ever have (at most a handful of devices per side) —
// this exists to turn a provable-safe race into a bounded number of
// retries, not to paper over a real design problem that would need more
// than a few attempts to resolve.
const MAX_SEQUENCE_RETRY_ATTEMPTS = 5;

// The shortest disappearing-timer preset is 10 seconds (DISAPPEARING_OPTIONS
// in domain/messageState.ts) — this needs to be comfortably shorter than
// that for a 10-second timer to feel real rather than lingering for most
// of its own duration after expiry. A plain setInterval, not a real job
// queue or @nestjs/schedule: this is a V1 lightweight solution for a
// single-process deployment, matching the instruction not to reach for
// enterprise infrastructure the app doesn't otherwise have. sync()'s own
// defensive filter (above) is what actually guarantees an expired
// message is never *handed out* even if this sweep is momentarily
// behind — this sweep's job is only to eventually make it physically
// gone (ciphertext wiped) and to tell anyone already watching.
const EXPIRY_SWEEP_INTERVAL_MS = 5_000;

@Injectable()
export class MessagesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MessagesService.name);
  private expirySweepTimer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ConnectionRegistryService,
    private readonly attachments: AttachmentsService,
  ) {}

  onModuleInit() {
    this.expirySweepTimer = setInterval(() => {
      this.cleanupExpiredMessages().catch((err) => this.logger.error(`Disappearing-message sweep failed: ${String(err)}`));
    }, EXPIRY_SWEEP_INTERVAL_MS);
    // Never keeps the process alive on its own — matters for scripts/tests
    // that spin up the app and expect the event loop to drain on exit.
    this.expirySweepTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.expirySweepTimer) clearInterval(this.expirySweepTimer);
  }

  /**
   * The actual disappearing-messages guarantee: a message whose
   * disappearAt has passed gets its ciphertext wiped (soft-deleted, the
   * same shape as deleteMessage() below — deletedAt set, ciphertext/nonce
   * zeroed, row kept as a tombstone) and both participants are notified
   * live if connected. Before this existed, disappearAt was computed and
   * stored on every message but nothing ever read it back except sync()'s
   * own defensive filter (above) — a message would never be *delivered*
   * late, but one already delivered and cached before it expired would
   * sit in the database, and in a still-open recipient's UI, forever.
   *
   * Runs as a periodic sweep rather than a per-message scheduled timer
   * (e.g. one setTimeout per message) — a single process handling many
   * conversations could otherwise accumulate an unbounded number of
   * pending timers; a short periodic scan bounds that at one timer,
   * total, regardless of how many messages are in flight.
   */
  async cleanupExpiredMessages(): Promise<number> {
    const now = new Date();
    const expired = await this.prisma.message.findMany({
      where: { disappearAt: { lte: now }, deletedAt: null },
      select: { id: true, conversationId: true },
      orderBy: { syncVersion: 'asc' },
    });
    if (expired.length === 0) return 0;

    // Grouped so a burst of expirations in one conversation triggers one
    // conversation lookup each, not one per message — and, since fixing
    // the same "offline recipient never learns about it" gap as
    // deleteMessage requires bumping syncVersion, grouping by
    // conversation is what lets each message in a burst get its own
    // distinct value rather than colliding on @@unique([conversationId,
    // syncVersion]) by sharing one.
    const byConversation = new Map<string, string[]>();
    for (const m of expired) {
      const list = byConversation.get(m.conversationId) ?? [];
      list.push(m.id);
      byConversation.set(m.conversationId, list);
    }
    for (const [conversationId, messageIds] of byConversation) {
      const convo = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
      if (!convo) continue; // conversation itself was burned in the same window — nothing left to notify
      for (const messageId of messageIds) {
        // Same reasoning as deleteMessage — a disappearing message with
        // an attached photo should not leave that photo recoverable
        // after the timer expires.
        await this.attachments.deleteForMessage(messageId);
        // Same race, same retry-on-conflict fix as deleteMessage/editMessage.
        for (let attempt = 0; ; attempt++) {
          const maxSeq = await this.prisma.message.aggregate({
            where: { conversationId },
            _max: { sequenceNumber: true, syncVersion: true },
          });
          const syncVersion = nextSequenceNumber(higherCounterValue(maxSeq._max.sequenceNumber, maxSeq._max.syncVersion));
          try {
            await this.prisma.message.update({
              where: { id: messageId },
              data: { deletedAt: now, ciphertext: Buffer.alloc(0), nonce: Buffer.alloc(0), syncVersion },
            });
            break;
          } catch (err) {
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && attempt < MAX_SEQUENCE_RETRY_ATTEMPTS - 1) {
              continue;
            }
            throw err;
          }
        }
        // Unlike deleteMessage() (sender-initiated, so only the
        // recipient needs telling — the sender's own client already
        // updated itself), neither party proactively triggers a timer
        // expiry, so both need the live push if connected. An offline
        // party gets the same signal from sync() instead, once
        // reconnected — see sync()'s own comment on including
        // tombstoned rows.
        this.registry.pushToUser(convo.userAId, 'message_deleted', { messageId, conversationId });
        this.registry.pushToUser(convo.userBId, 'message_deleted', { messageId, conversationId });
      }
    }
    return expired.length;
  }

  private async getActiveConversationOrThrow(userId: string, conversationId: string) {
    const convo = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!convo) throw new NotFoundException('Conversation not found');
    if (convo.userAId !== userId && convo.userBId !== userId) throw new ForbiddenException();
    if (convo.status !== 'ACTIVE') throw new ForbiddenException('Conversation not available');
    return convo;
  }

  async send(userId: string, dto: SendMessageDto) {
    const convo = await this.getActiveConversationOrThrow(userId, dto.conversationId);
    // The hard backstop against a stale-session send: getActiveConversationOrThrow
    // above only checks that the conversation is *currently* ACTIVE, which
    // is also true immediately after a re-pair — so on its own it cannot
    // tell a message encrypted under a burned-and-superseded session
    // apart from a legitimate current one; both would pass. A client
    // that missed the burn+re-pair (was offline, or simply hasn't
    // reconciled yet) would otherwise be able to write ciphertext the
    // recipient's new session can never decrypt straight into the new
    // conversation. See domain/sessionEpoch.ts.
    if (isStaleEpoch(dto.sessionEpoch, convo.sessionEpoch)) {
      throw new ConflictException({ error: 'STALE_SESSION_EPOCH', currentSessionEpoch: convo.sessionEpoch });
    }

    // SECURITY AUDIT F6: Validate that if replyToMessageId is provided, the
    // referenced message exists and belongs to this exact same conversation.
    // Querying both id and conversationId simultaneously guarantees that a
    // message belonging to a different conversation yields the exact same
    // 404 error as a non-existent message, preventing cross-conversation
    // message ID existence oracles / information leakage.
    if (dto.replyToMessageId) {
      const referencedMessage = await this.prisma.message.findFirst({
        where: { id: dto.replyToMessageId, conversationId: dto.conversationId },
        select: { id: true },
      });
      if (!referencedMessage) {
        throw new NotFoundException('Referenced reply message not found');
      }
    }

    const recipientId = convo.userAId === userId ? convo.userBId : convo.userAId;

    // The @@unique([conversationId, clientMessageId]) constraint is the
    // real guarantee; this lookup exists to return the existing message
    // instead of a raw constraint-violation error on a legitimate retry
    // (see docs/02-DATABASE-SCHEMA.md and messageState.ts's isDuplicateSend,
    // which this mirrors at the single-row-lookup level rather than
    // scanning every message in the conversation).
    const existing = await this.prisma.message.findUnique({
      where: { conversationId_clientMessageId: { conversationId: dto.conversationId, clientMessageId: dto.clientMessageId } },
    });
    if (existing) return { id: existing.id, sequenceNumber: Number(existing.sequenceNumber), sentAt: existing.sentAt, deduped: true };

    const [recipientSettings, conversation] = await Promise.all([
      this.prisma.userSettings.findUnique({ where: { userId: recipientId } }),
      this.prisma.conversation.findUniqueOrThrow({ where: { id: dto.conversationId } }),
    ]);
    const sentAt = new Date();
    let disappearAt: Date | null = null;
    if (conversation.disappearingTimerSeconds && conversation.disappearingTrigger) {
      const trigger = resolveDisappearTrigger({
        timerSeconds: conversation.disappearingTimerSeconds,
        trigger: conversation.disappearingTrigger.toLowerCase() as 'sent' | 'delivered' | 'read',
        readReceiptsEnabled: recipientSettings?.readReceiptsEnabled ?? true,
      });
      if (trigger === 'sent') {
        disappearAt = computeDisappearAt(
          { timerSeconds: conversation.disappearingTimerSeconds, trigger, readReceiptsEnabled: true },
          { sentAt },
        );
      }
      // 'delivered'/'read' triggers are computed when that event actually
      // happens (see markDelivered/markRead below) — not knowable yet here.
    }

    const message = await this.createMessageWithRetry(dto, userId, sentAt, disappearAt);
    if (message.deduped) return message;

    // THE FIX: attachment linking used to require dto.encryptedDek to be
    // present too — see linkToMessage's own doc comment for the full
    // story on why that made every real attachment send silently a
    // no-op. attachmentId alone is both necessary and sufficient.
    if (dto.attachmentId) {
      await this.attachments.linkToMessage(
        dto.attachmentId,
        message.id,
        dto.conversationId,
        userId,
        dto.encryptedDek ? Buffer.from(dto.encryptedDek, 'base64') : null,
      );
    }

    const delivered = this.registry.pushToUser(recipientId, 'message', {
      id: message.id,
      conversationId: dto.conversationId,
      senderId: userId,
      sequenceNumber: Number(message.sequenceNumber),
      ciphertext: dto.ciphertext,
      iv: dto.iv,
      messageType: dto.messageType,
      replyToMessageId: dto.replyToMessageId ?? null,
      sentAt,
    });
    if (delivered) {
      await this.markDelivered(message.id, conversation);
    }

    return { id: message.id, sequenceNumber: Number(message.sequenceNumber), sentAt, delivered };
  }

  /**
   * Isolates the one part of send() that has a real race window: the
   * sequence-number counter is derived from MAX(sequenceNumber) rather
   * than a dedicated atomic counter (see nextSequenceNumber in
   * messageState.ts), and Prisma/Postgres's default READ COMMITTED
   * isolation does not serialize that read against a concurrent sender —
   * two devices sending into the same conversation at nearly the same
   * moment can legitimately both compute the same "next" number. The
   * @@unique([conversationId, sequenceNumber]) constraint is what
   * actually prevents that from ever becoming a duplicate sequence
   * number (which the ratchet's AAD depends on being unique per
   * conversation) — but on its own, hitting that constraint just throws,
   * which previously propagated all the way out as an unhandled 500 for
   * whichever request lost the race. This retries the loser with a fresh
   * sequence number instead, bounded by MAX_SEQUENCE_RETRY_ATTEMPTS.
   */
  private async createMessageWithRetry(dto: SendMessageDto, userId: string, sentAt: Date, disappearAt: Date | null) {
    for (let attempt = 0; attempt < MAX_SEQUENCE_RETRY_ATTEMPTS; attempt++) {
      const maxSeq = await this.prisma.message.aggregate({
        where: { conversationId: dto.conversationId },
        _max: { sequenceNumber: true, syncVersion: true },
      });
      // syncVersion can exceed sequenceNumber (an edit bumps only the former —
      // see editMessage below), so the next value from this shared counter
      // has to clear whichever of the two is currently higher, not just
      // sequenceNumber alone, or a later edit could collide with an
      // already-issued sequenceNumber.
      const currentMax = higherCounterValue(maxSeq._max.sequenceNumber, maxSeq._max.syncVersion);
      const sequenceNumber = nextSequenceNumber(currentMax);

      try {
        const message = await this.prisma.message.create({
          data: {
            conversationId: dto.conversationId,
            senderId: userId,
            sequenceNumber,
            syncVersion: sequenceNumber,
            clientMessageId: dto.clientMessageId,
            ciphertext: Buffer.from(dto.ciphertext, 'base64'),
            nonce: Buffer.from(dto.iv, 'base64'),
            messageType: dto.messageType,
            replyToMessageId: dto.replyToMessageId,
            sentAt,
            disappearAt,
          },
        });
        return { ...message, deduped: false as const };
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          // Two different unique constraints share this one create() call
          // (conversationId+sequenceNumber, and conversationId+clientMessageId),
          // and Prisma's error metadata for *which* one fired isn't a
          // stable enough shape to branch on directly. Asking the more
          // useful question instead: did the request that beat us have the
          // *same* clientMessageId as this one? If so, this was never a
          // sequence-number race — it's the ordinary duplicate-send case
          // arriving concurrently rather than sequentially, and the right
          // answer is identical to the sequential case: return the message
          // that now exists, not an error.
          const existing = await this.prisma.message.findUnique({
            where: { conversationId_clientMessageId: { conversationId: dto.conversationId, clientMessageId: dto.clientMessageId } },
          });
          if (existing) {
            return { id: existing.id, sequenceNumber: Number(existing.sequenceNumber), sentAt: existing.sentAt, deduped: true as const };
          }
          // Otherwise, a *different* message just took this sequence
          // number — loop back and claim the next one.
          continue;
        }
        throw err;
      }
    }
    throw new ConflictException('Could not allocate a message sequence number after repeated attempts — please retry.');
  }

  private async markDelivered(messageId: string, conversation: { disappearingTimerSeconds: number | null; disappearingTrigger: string | null }) {
    const now = new Date();
    const data: { deliveredAt: Date; disappearAt?: Date } = { deliveredAt: now };
    if (
      conversation.disappearingTimerSeconds &&
      conversation.disappearingTrigger?.toLowerCase() === 'delivered'
    ) {
      data.disappearAt = computeDisappearAt(
        { timerSeconds: conversation.disappearingTimerSeconds, trigger: 'delivered', readReceiptsEnabled: true },
        { sentAt: now, deliveredAt: now },
      )!;
    }
    await this.prisma.message.update({ where: { id: messageId }, data });
  }

  async sync(userId: string, conversationId: string, after: number) {
    const convo = await this.getActiveConversationOrThrow(userId, conversationId);
    // senderId: { not: userId } is the actual fix — sync means "what do I
    // still need to receive." A caller's own sent messages were never
    // "incoming" to them in the first place, and returning them here (as
    // the previous version did) meant the client would attempt to
    // ratchet-decrypt its own ciphertext with its own receiving chain —
    // always the wrong key for that content, which would fail to decrypt.
    // Note this is no longer a *safe* kind of failure to lean on even
    // incidentally: the V1 pre-runtime hardening pass fixed
    // processIncoming (app/chat/[conversationId]/page.tsx) so a decrypt
    // failure DOES now advance the receiving chain (deriveNextChainKey)
    // — necessarily, since not doing so was itself the far worse bug
    // (one failure permanently breaking every later message). That makes
    // this senderId filter more important, not less: without it, the
    // client's own messages leaking back through sync would burn real
    // steps off its own receiving chain for no reason, desynchronizing
    // it from the sender's actual chain position exactly the way a
    // genuine decrypt failure now correctly recovers from, except here
    // there'd be nothing to recover from — it would be self-inflicted.
    //
    // deletedAt is deliberately NOT excluded here (a previous version
    // filtered it out entirely) — a deleted message still needs to reach
    // a recipient who was offline when the deletion happened, so they
    // remove it from their own local cache instead of it sitting there
    // forever with no future signal ever correcting it. See the
    // response mapping below for how a client tells a real message
    // apart from a deletion tombstone.
    const messages = await this.prisma.message.findMany({
      where: {
        conversationId,
        senderId: { not: userId },
        syncVersion: { gt: after },
        OR: [
          { disappearAt: null },
          // Defensive, in addition to the periodic sweep: a message
          // whose disappearAt has already passed must never be handed
          // out as live content, even in the window before the next
          // sweep tick catches it.
          { disappearAt: { gt: new Date() } },
          // But once it HAS been tombstoned (by that same sweep, or by
          // an explicit delete), it needs to flow through like any
          // other deletion — excluding it here would silently undo the
          // fix above for exactly the offline-recipient case that fix
          // is for.
          { deletedAt: { not: null } },
        ],
      },
      orderBy: { syncVersion: 'asc' },
    });

    const now = new Date();
    const toMarkDelivered = messages.filter((m) => !m.deliveredAt && !m.deletedAt).map((m) => m.id);
    if (toMarkDelivered.length > 0) {
      // This used to only set deliveredAt — meaning a conversation whose
      // disappearing timer is anchored to "delivered" would never
      // actually start that timer for any message the recipient was
      // offline for at send time (the only place disappearAt got computed
      // for that trigger was markDelivered(), used solely by send()'s own
      // immediate-push path). A message synced later than it was sent
      // would sit forever, never disappearing, silently defeating the
      // feature for exactly the "recipient was offline" case disappearing
      // messages most need to handle correctly.
      const data: { deliveredAt: Date; disappearAt?: Date } = { deliveredAt: now };
      if (convo.disappearingTimerSeconds && convo.disappearingTrigger?.toLowerCase() === 'delivered') {
        data.disappearAt = computeDisappearAt(
          { timerSeconds: convo.disappearingTimerSeconds, trigger: 'delivered', readReceiptsEnabled: true },
          { sentAt: now, deliveredAt: now },
        )!;
      }
      await this.prisma.message.updateMany({ where: { id: { in: toMarkDelivered } }, data });
    }

    return messages.map((m) => ({
      id: m.id,
      senderId: m.senderId,
      sequenceNumber: Number(m.syncVersion),
      // A tombstoned row's ciphertext/nonce are already wiped to empty
      // buffers (deleteMessage / cleanupExpiredMessages), so this would
      // encode to an empty string either way — `deleted` is what the
      // client actually branches on, spelled out explicitly rather than
      // left for the client to infer from "ciphertext happens to be
      // empty" (which is also indistinguishable from a genuine zero-length
      // plaintext otherwise).
      deleted: !!m.deletedAt,
      ciphertext: m.ciphertext.toString('base64'),
      iv: m.nonce.toString('base64'),
      messageType: m.messageType,
      replyToMessageId: m.replyToMessageId,
      sentAt: m.sentAt,
    }));
  }

  async markRead(userId: string, messageId: string) {
    const message = await this.prisma.message.findUnique({ where: { id: messageId }, include: { conversation: true } });
    if (!message) throw new NotFoundException('Message not found');
    if (message.senderId === userId) throw new BadRequestException('Cannot mark your own message as read');
    const convo = message.conversation;
    if (convo.userAId !== userId && convo.userBId !== userId) throw new ForbiddenException();

    // The READER's (userId's) own setting, not the sender's — this is
    // what "did I let people know I've seen their messages" means: it's
    // a preference about what *you* reveal, not what you're told.
    // Previously hardcoded to true regardless of either party's actual
    // setting, meaning turning this setting off had no real effect —
    // the sender was told "read" every time either way.
    const readerSettings = await this.prisma.userSettings.findUnique({ where: { userId } });
    const readReceiptsEnabled = readerSettings?.readReceiptsEnabled ?? true;

    const now = new Date();
    const data: { readAt: Date; disappearAt?: Date } = { readAt: now };
    if (convo.disappearingTimerSeconds && convo.disappearingTrigger) {
      // resolveDisappearTrigger already knows how to fall back from
      // 'read' to 'delivered' when read receipts are off (you can't
      // anchor a timer to an event you're not tracking/sharing) — passing
      // the reader's *actual current* setting here, instead of a
      // hardcoded true, is what lets that fallback actually engage.
      const trigger = resolveDisappearTrigger({
        timerSeconds: convo.disappearingTimerSeconds,
        trigger: convo.disappearingTrigger.toLowerCase() as 'sent' | 'delivered' | 'read',
        readReceiptsEnabled,
      });
      if (trigger === 'read') {
        data.disappearAt = computeDisappearAt(
          { timerSeconds: convo.disappearingTimerSeconds, trigger: 'read', readReceiptsEnabled },
          { sentAt: message.sentAt, deliveredAt: message.deliveredAt, readAt: now },
        )!;
      }
    }
    await this.prisma.message.update({ where: { id: messageId }, data });
    // readAt is still recorded either way (harmless — it's this server's
    // own bookkeeping, never exposed to the sender directly), but the
    // read_receipt push — the part that actually tells the sender
    // anything — only happens if the reader has left this on.
    if (readReceiptsEnabled) {
      this.registry.pushToUser(message.senderId, 'read_receipt', { messageId, conversationId: convo.id });
    }
  }

  async deleteMessage(userId: string, messageId: string) {
    const message = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!message || message.senderId !== userId) throw new NotFoundException('Message not found');
    // Any linked attachment first — see AttachmentsService.deleteForMessage's
    // comment for why this needs its own explicit cleanup rather than
    // relying on the DB's onDelete: Cascade (that cascade never fires
    // for a soft delete, which is what this is).
    await this.attachments.deleteForMessage(messageId);
    // Same race as createMessageWithRetry/editMessage, same fix — see
    // schema.prisma's @@unique([conversationId, syncVersion]) comment.
    // Bumping syncVersion here (not just setting deletedAt) is what
    // makes this deletion visible to sync() at all: a client who had
    // already synced past this message's original syncVersion (i.e.
    // they already have it cached) would otherwise never see it again
    // in any future sync — the deletion would only ever reach them via
    // the live push below, so an offline recipient would keep the
    // now-deleted message cached locally forever, with nothing ever
    // correcting it on reconnect.
    let syncVersion: bigint;
    for (let attempt = 0; ; attempt++) {
      const maxSeq = await this.prisma.message.aggregate({
        where: { conversationId: message.conversationId },
        _max: { sequenceNumber: true, syncVersion: true },
      });
      syncVersion = nextSequenceNumber(higherCounterValue(maxSeq._max.sequenceNumber, maxSeq._max.syncVersion));
      try {
        // Deletion actually removes the ciphertext, not just a UI flag —
        // a "deleted" message with its ciphertext still sitting in the
        // database isn't really deleted, it's hidden.
        await this.prisma.message.update({
          where: { id: messageId },
          data: { deletedAt: new Date(), ciphertext: Buffer.alloc(0), nonce: Buffer.alloc(0), syncVersion },
        });
        break;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && attempt < MAX_SEQUENCE_RETRY_ATTEMPTS - 1) {
          continue;
        }
        throw err;
      }
    }
    const convo = await this.prisma.conversation.findUniqueOrThrow({ where: { id: message.conversationId } });
    const recipientId = convo.userAId === userId ? convo.userBId : convo.userAId;
    this.registry.pushToUser(recipientId, 'message_deleted', { messageId, conversationId: message.conversationId });
  }

  async editMessage(userId: string, messageId: string, ciphertext: string, iv: string) {
    const message = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!message || message.senderId !== userId) throw new NotFoundException('Message not found');
    if (message.deletedAt) throw new BadRequestException('Cannot edit a deleted message');

    // Same race as createMessageWithRetry, and caught the same way: an
    // edit computes its new syncVersion via MAX(...)+1 too (see
    // higherCounterValue), so a concurrent send or a second concurrent
    // edit in this conversation can legitimately compute the same
    // "next" value. @@unique([conversationId, syncVersion]) is what
    // makes that detectable at all (see schema.prisma's comment on that
    // constraint); this retries the loser instead of letting the
    // conflict propagate as an unhandled 500.
    let syncVersion: bigint;
    for (let attempt = 0; ; attempt++) {
      const maxSeq = await this.prisma.message.aggregate({
        where: { conversationId: message.conversationId },
        _max: { sequenceNumber: true, syncVersion: true },
      });
      syncVersion = nextSequenceNumber(higherCounterValue(maxSeq._max.sequenceNumber, maxSeq._max.syncVersion));
      try {
        await this.prisma.message.update({
          where: { id: messageId },
          data: { ciphertext: Buffer.from(ciphertext, 'base64'), nonce: Buffer.from(iv, 'base64'), editedAt: new Date(), syncVersion },
        });
        break;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && attempt < MAX_SEQUENCE_RETRY_ATTEMPTS - 1) {
          continue;
        }
        throw err;
      }
    }

    const convo = await this.prisma.conversation.findUniqueOrThrow({ where: { id: message.conversationId } });
    const recipientId = convo.userAId === userId ? convo.userBId : convo.userAId;
    this.registry.pushToUser(recipientId, 'message_edited', {
      messageId,
      conversationId: message.conversationId,
      senderId: userId,
      sequenceNumber: Number(syncVersion),
      ciphertext,
      iv,
      sentAt: message.sentAt,
    });
  }
}
