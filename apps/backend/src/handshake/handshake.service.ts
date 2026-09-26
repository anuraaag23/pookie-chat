import { Injectable, NotFoundException, ForbiddenException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isStaleEpoch, isUsableForHandshake } from '../domain/sessionEpoch';

@Injectable()
export class HandshakeService {
  constructor(private readonly prisma: PrismaService) {}

  async store(userId: string, conversationId: string, handshakeMessage: unknown, sessionEpoch?: number) {
    const convo = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!convo) throw new NotFoundException('Conversation not found');
    if (convo.userAId !== userId && convo.userBId !== userId) throw new ForbiddenException();
    // A burned (or blocked) conversation cannot accept new handshake
    // material — without this, a store() call already in flight when a
    // burn lands (or a stale client retry arriving after one) could
    // recreate pending handshake state for a conversation that's
    // supposed to be dead, which is exactly the "old pending handshake
    // recreates the old conversation" failure mode burn is meant to
    // prevent. A legitimate re-pair always goes through
    // PairingService.redeem first, which puts the conversation back to
    // ACTIVE before the client ever calls this — so this never rejects
    // the real flow, only genuinely stale/out-of-order calls.
    if (!isUsableForHandshake(convo.status) || (convo.expiresAt && convo.expiresAt.getTime() <= Date.now())) {
      throw new ForbiddenException('Conversation not available');
    }
    // The client learns sessionEpoch from PairingService.redeem's
    // response and carries it straight into this call. If it no longer
    // matches, a *later* redemption has already superseded the pairing
    // this handshake message was generated for (e.g. the two people
    // paired again before this store() call landed) — storing it anyway
    // would let a stale handshake silently become "the" pending
    // handshake for the new pairing. Absent entirely (older caller that
    // predates epoch-awareness), this check is skipped — see
    // isStaleEpoch's own contract for why that's still safe.
    if (isStaleEpoch(sessionEpoch, convo.sessionEpoch)) {
      throw new ConflictException('This pairing has been superseded — request a fresh pairing code and try again.');
    }
    const recipientUserId = convo.userAId === userId ? convo.userBId : convo.userAId;

    await this.prisma.pendingHandshake.upsert({
      where: { conversationId },
      create: { conversationId, recipientUserId, payload: handshakeMessage as object, sessionEpoch: convo.sessionEpoch },
      update: { recipientUserId, payload: handshakeMessage as object, sessionEpoch: convo.sessionEpoch },
    });
  }

  async fetch(userId: string, conversationId: string) {
    const convo = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    // Same "nothing valid for you" response whether the conversation
    // doesn't exist, was never paired, or was burned and never
    // re-paired — a client recovering from any of these takes the exact
    // same action (fall through to re-pairing), so there is no reason
    // to give an attacker-distinguishable signal between them.
    if (!convo || !isUsableForHandshake(convo.status) || (convo.expiresAt && convo.expiresAt.getTime() <= Date.now())) {
      throw new NotFoundException('No pending handshake');
    }
    const pending = await this.prisma.pendingHandshake.findUnique({ where: { conversationId } });
    if (!pending || pending.recipientUserId !== userId) {
      throw new NotFoundException('No pending handshake');
    }
    // Defense in depth beyond store()'s own check: even if a stale row
    // somehow survived (e.g. a re-pair happened without an intervening
    // burn — burn is what explicitly clears this table, a plain re-pair
    // over an already-ACTIVE conversation does not, since the redeemer's
    // own store() call is expected to overwrite it), never hand out a
    // handshake whose epoch doesn't match the conversation's current
    // one. Completing a stale handshake would derive a session for a
    // pairing that's no longer the authoritative one.
    if (isStaleEpoch(pending.sessionEpoch, convo.sessionEpoch)) {
      throw new NotFoundException('No pending handshake');
    }
    // Deliberately NOT deleted here, even though it's now "used": the
    // caller (app/chat/[conversationId]/page.tsx's bootstrap) fetches this,
    // then runs completeHandshake() and initSession() locally afterward —
    // if either of those fails (tab closes, IndexedDB write error) before
    // the session is actually persisted, the very next thing that page
    // does on reopen is call fetch() again. Consuming on first read would
    // turn that transient failure into a permanent lockout. Burn already
    // deletes this row explicitly (conversations.service.ts) when a stale
    // handshake genuinely needs cleaning up after a re-pair.
    return { handshakeMessage: pending.payload, sessionEpoch: pending.sessionEpoch };
  }
}
