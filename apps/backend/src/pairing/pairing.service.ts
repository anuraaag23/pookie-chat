import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { APP_CONFIG } from '../config/config.module';
import { AppConfig } from '../config/env';
import { generatePairingCode, hashPairingCode, verifyPairingCode, computeExpiresAt, isExpired, isLockedOut, recordFailedAttempt } from '../domain/pairingCode';

function canonicalPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

// A 6-digit code is only 1,000,000 possible values (docs/01-THREAT-MODEL.md's
// short-lived, single-use, HMAC-compared design accepts that keyspace
// deliberately — see PairingController's own rate limiting). Two different
// users generating the identical 6-digit string while both codes are
// simultaneously ACTIVE is rare but entirely possible under real load, and
// @@unique([codeHmac, status]) means the second create() to land would hit a
// P2002 for reasons that have nothing to do with either user doing anything
// wrong. 5 attempts, same bound as messages.service.ts's sequence-number
// retry, makes this astronomically unlikely to ever exhaust — this exists so
// an unlucky hash collision is retried with a fresh code instead of
// surfacing as an unhandled 500 for an ordinary, legitimate request.
const MAX_CODE_COLLISION_RETRY_ATTEMPTS = 5;

@Injectable()
export class PairingService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async create(userId: string, durationSeconds: number | null | undefined) {
    const expiresAt = computeExpiresAt(durationSeconds ?? null) ?? undefined;
    for (let attempt = 0; attempt < MAX_CODE_COLLISION_RETRY_ATTEMPTS; attempt++) {
      const code = generatePairingCode();
      try {
        const record = await this.prisma.pairingCode.create({
          data: {
            creatorUserId: userId,
            codeHmac: hashPairingCode(code, this.config.pairingCodePepper),
            expiresAt,
          },
        });
        return { pairingId: record.id, code, expiresAt: record.expiresAt };
      } catch (err) {
        // THE FIX (found during the final V1 pre-runtime audit): retry with
        // a freshly generated code on a genuine hash collision against
        // another still-active code, instead of letting it propagate as an
        // unhandled 500. Any other error (a real DB problem, a config
        // issue) still throws immediately — this only ever catches the one
        // specific, expected, recoverable case.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && attempt < MAX_CODE_COLLISION_RETRY_ATTEMPTS - 1) {
          continue;
        }
        throw err;
      }
    }
    // Unreachable in practice (the loop above always returns or throws),
    // but keeps this function's return type honest without a non-null
    // assertion.
    throw new Error('Could not generate a unique pairing code after repeated attempts — please retry.');
  }

  async revoke(userId: string, pairingId: string) {
    const record = await this.prisma.pairingCode.findUnique({ where: { id: pairingId } });
    if (!record || record.creatorUserId !== userId) throw new NotFoundException('Not found');
    await this.prisma.pairingCode.update({ where: { id: pairingId }, data: { status: 'REVOKED' } });
    await this.prisma.securityEvent.create({ data: { userId, eventType: 'PAIRING_REVOKED', metadata: { pairingId } } });
  }

  async redeem(redeemerUserId: string, code: string) {
    // Every currently-active code is a small (bounded) set — this is the
    // one place a full table scan of active codes is acceptable, since
    // the alternative (a plaintext-indexable code column) is exactly what
    // the HMAC design avoids. See docs/02-DATABASE-SCHEMA.md.
    const candidates = await this.prisma.pairingCode.findMany({ where: { status: 'ACTIVE' } });
    const GENERIC_ERROR = 'Invalid or expired code';
    const match = candidates.find((c) => verifyPairingCode(code, this.config.pairingCodePepper, c.codeHmac));

    if (!match) {
      // isLockedOut/recordFailedAttempt (domain/pairingCode.ts) existed,
      // fully unit-tested, and were never actually called from
      // anywhere — found while re-verifying pairing security end to
      // end. There was a *read* of a code's lockedUntil a few lines
      // below, but nothing had ever written one, so that check could
      // never actually fire: pairing-code guessing had no rate limit
      // at all.
      //
      // A wrong guess can't be attributed to the one specific code it
      // was "aimed at" — that's exactly what makes HMAC comparison
      // secure, an attacker gets a flat no/yes with nothing in between
      // to narrow down. What it's aimed at is only knowable if it
      // matches; if it doesn't, treat it as pressure against every
      // currently-active code equally, since from the guesser's
      // perspective they're statistically indistinguishable. A
      // sustained brute-force attempt still gets shut down (every
      // active code it could have been targeting becomes dead and must
      // be regenerated) — the tradeoff is that a burst of wrong guesses
      // aimed at one pairing can, as a side effect, also lock out a
      // different, unrelated pairing that happened to be active at the
      // same moment. Codes are cheap and quick to regenerate, so this
      // errs toward shutting down guessing rather than precision.
      await Promise.all(
        candidates.map(async (c) => {
          const result = recordFailedAttempt({ failedAttempts: c.failedAttempts, lockedUntil: c.lockedUntil });
          await this.prisma.pairingCode.update({
            where: { id: c.id },
            data: { failedAttempts: result.failedAttempts, lockedUntil: result.lockedUntil },
          });
        }),
      );
      throw new BadRequestException(GENERIC_ERROR);
    }

    if (isLockedOut({ failedAttempts: match.failedAttempts, lockedUntil: match.lockedUntil })) {
      throw new BadRequestException(GENERIC_ERROR);
    }

    if (isExpired(match.expiresAt)) {
      await this.prisma.pairingCode.update({ where: { id: match.id }, data: { status: 'EXPIRED' } });
      throw new BadRequestException(GENERIC_ERROR);
    }

    if (match.creatorUserId === redeemerUserId) {
      throw new BadRequestException('Cannot pair with yourself');
    }

    // Checked here — before consuming the code or touching the
    // conversation row — so a creator whose only device has since been
    // revoked fails the redemption without mutating anything. This used
    // to run after both of those mutations: the pairing code would be
    // burned (permanently unredeemable) and, for a re-pair-after-burn,
    // the conversation would already be bumped to a new epoch and
    // reactivated to ACTIVE, all before this check could reject the
    // request — leaving an orphaned, handshake-less "ACTIVE" conversation
    // behind for a redemption that never actually completed. Not a
    // security hole (no old ciphertext resurfaces, and a stale cached
    // session on either side is still correctly caught by the epoch
    // mismatch on its next check), but exactly the "consumes state too
    // early / leaves inconsistent state" class of bug this task is
    // about — and checking first also means the code the two people
    // already exchanged out-of-band is still redeemable on a retry once
    // the creator has a working device again, instead of forcing them to
    // generate and re-share an entirely new one.
    const creatorDevice = await this.prisma.device.findFirst({
      where: { userId: match.creatorUserId, revokedAt: null },
      orderBy: { lastSeenAt: 'desc' },
    });
    if (!creatorDevice) throw new BadRequestException(GENERIC_ERROR);

    // THE FIX (found during the final V1 pre-runtime audit): the code's
    // own comments already establish that the *concurrent-request* race
    // here is handled (the updateMany's WHERE guard, the atomic
    // increment) — what wasn't covered is a crash or request timeout
    // landing between these two writes specifically. Before this fix,
    // that left a window where the pairing code could end up permanently
    // marked USED with no conversation ever created for it — the two
    // people would have exchanged a code that's now unredeemable and
    // produced nothing. $transaction makes the two writes atomic: either
    // both land or neither does, and a crash mid-way leaves the code
    // exactly as it was (ACTIVE, redeemable again on retry) rather than
    // half-consumed. oneTimePrekey consumption joins the same boundary,
    // since it's the same "state that must not be partially applied"
    // category. securityEvent logging deliberately stays outside it —
    // an audit-log write failing or losing a race should never be able
    // to roll back a real pairing that otherwise succeeded.
    //
    // Not harness-testable in any way that would mean something: the
    // harness's node:sqlite runs every statement synchronously with no
    // real interleaving to begin with (see retryOnUniqueConflict's own
    // comments on this same limitation), and it has no equivalent of a
    // genuine mid-transaction crash. This is code-reviewed only.
    const { conversation, oneTimePrekey } = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.pairingCode.updateMany({
        where: { id: match.id, status: 'ACTIVE' }, // guards against a race between two simultaneous redeem attempts
        data: { status: 'USED', usedByUserId: redeemerUserId, usedAt: new Date() },
      });
      if (updated.count === 0) throw new BadRequestException(GENERIC_ERROR); // someone else redeemed it a moment ago

      const [userAId, userBId] = canonicalPair(match.creatorUserId, redeemerUserId);

      // SECURITY AUDIT F1 FIX: a plain upsert here used to unconditionally
      // flip an *existing* row's status to ACTIVE on its update branch, with
      // no regard for what that status currently was — including
      // BLOCKED_BY_A/BLOCKED_BY_B. That silently lifted a block without the
      // blocking party ever calling unblock(), which is the exact invariant
      // unblock()'s own comment states: "only the person who initiated the
      // block can lift it — the other party being blocked has no way to
      // un-block themselves" (conversations.service.ts). A redeemer could
      // trivially get around that by just generating a fresh pairing code
      // and getting the blocker to redeem it.
      //
      // Fix shape: try the create first (the genuinely-new-pairing case,
      // unaffected by any of this). Only when a row already exists (P2002 on
      // the @@unique([userAId, userBId]) constraint) do we fall back to an
      // update — and that update's WHERE clause explicitly excludes both
      // blocked statuses, so a blocked row is left completely untouched: not
      // reactivated, not touched, sessionEpoch not bumped. It gets the exact
      // same generic rejection as every other invalid-redemption path,
      // revealing nothing about *why* it failed (not that the code was
      // valid, not that a blocked conversation even exists).
      //
      // Race-safety: this reuses the SAME WHERE-guard compare-and-swap idiom
      // already used a few lines above for the pairing code itself (and for
      // refresh-token rotation) — the update's WHERE clause re-checks the
      // row's current status as part of the single statement that writes to
      // it, so there is no separate "read status, then write" window for a
      // concurrent block() or a second concurrent redeem() to land in
      // between. The statement either updates the one row that, at the
      // instant the database executes it, is not BLOCKED_BY_A/B, or it
      // updates zero rows — there's no gap in between for a race to exploit.
      let conversation: Awaited<ReturnType<typeof tx.conversation.create>>;
      try {
        // Genuinely new pairing: no existing row for this canonical pair.
        conversation = await tx.conversation.create({ data: { userAId, userBId } });
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) {
          throw err;
        }
        // A row already exists for this pair — an ordinary re-pair of an
        // already-ACTIVE conversation, a re-pair after a burn
        // (docs/02-DATABASE-SCHEMA.md — burn() sets status DELETED, and this
        // reactivates + resets it, same as before this fix), or — the case
        // this fix closes — an attempt to reactivate a conversation one side
        // explicitly blocked.
        //
        // Stale disappearing-timer settings from the old pairing are
        // cleared too, since this is meant to be a fresh start.
        //
        // sessionEpoch always advances here on every successful redemption,
        // not only after a burn, since a redemption always means a
        // brand-new X3DH handshake is about to begin (see the client's
        // initiateHandshake call right after this returns). This is what
        // lets a device that cached a session from the *previous* pairing
        // detect that session is stale, whether that previous pairing ended
        // in a burn or the two people simply paired again without one.
        // Uses Prisma's atomic increment rather than a read-then-write so
        // two concurrent redemptions for the same pair can't silently
        // clobber each other's bump — see domain/sessionEpoch.ts for the
        // rest of the epoch contract. Both of those effects only apply on
        // the branch below where the WHERE guard actually matched a row —
        // a blocked row never sees either.
        const updated = await tx.conversation.updateMany({
          where: { userAId, userBId, status: { notIn: ['BLOCKED_BY_A', 'BLOCKED_BY_B'] } },
          data: { status: 'ACTIVE', disappearingTimerSeconds: null, disappearingTrigger: null, sessionEpoch: { increment: 1 } },
        });
        if (updated.count === 0) {
          // Either genuinely blocked (the case this fix targets), or —
          // astronomically unlikely — the row vanished between the failed
          // create and here. Both get the same generic rejection.
          throw new BadRequestException(GENERIC_ERROR);
        }
        conversation = await tx.conversation.findUniqueOrThrow({ where: { userAId_userBId: { userAId, userBId } } });
      }

      const oneTimePrekey = await tx.oneTimePrekey.findFirst({
        where: { deviceId: creatorDevice.id, usedAt: null },
      });
      if (oneTimePrekey) {
        await tx.oneTimePrekey.update({ where: { id: oneTimePrekey.id }, data: { usedAt: new Date() } });
      }
      return { conversation, oneTimePrekey };
    });

    await this.prisma.securityEvent.createMany({
      data: [
        { userId: match.creatorUserId, eventType: 'NEW_PAIRING', metadata: { conversationId: conversation.id } },
        { userId: redeemerUserId, eventType: 'NEW_PAIRING', metadata: { conversationId: conversation.id } },
      ],
    });

    return {
      conversationId: conversation.id,
      // The epoch this brand-new handshake belongs to — the client
      // carries this through initiateHandshake's POST /api/handshake
      // call and into initSession, so its locally stored session is
      // tagged with the epoch it actually corresponds to from the
      // moment it exists. See domain/sessionEpoch.ts.
      sessionEpoch: conversation.sessionEpoch,
      bundle: {
        identityDhPublic: creatorDevice.identityDhPublic,
        identitySigningPublic: creatorDevice.identitySigningPublic,
        signedPrekeyPublic: creatorDevice.signedPrekeyPublic,
        signedPrekeySignature: creatorDevice.signedPrekeySignature,
        oneTimePrekeyPublic: oneTimePrekey?.publicKey,
      },
    };
  }

  // PairingCode.failedAttempts/lockedUntil exist in the schema as a hook
  // for a future distributed rate limiter (e.g. Redis-backed, tracking
  // guesses per requester across all codes) — deliberately not populated
  // by this in-process implementation, since a real implementation of
  // that hook needs infrastructure this sandbox can't stand up, and a
  // fake one would be worse than an honest gap. The defense that IS real
  // and active today is the per-user rate limit on the
  // `POST /api/pairing/redeem` route itself — see PairingController.
}
