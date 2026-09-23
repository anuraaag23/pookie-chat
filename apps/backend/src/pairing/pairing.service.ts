import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { APP_CONFIG } from '../config/config.module';
import { AppConfig } from '../config/env';
import {
  generatePairingCode,
  generateForeverCode,
  encryptPairingCode,
  decryptPairingCode,
  normalizePairingCode,
  hashPairingCode,
  verifyPairingCode,
  computeExpiresAt,
  isExpired,
  isLockedOut,
  recordFailedAttempt,
} from '../domain/pairingCode';

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
    const isForever = durationSeconds === null;
    if (isForever) {
      // Idempotency: If creator already has an active Forever Code, return it
      const existing = await this.prisma.pairingCode.findFirst({
        where: {
          creatorUserId: userId,
          expiresAt: null,
          status: 'ACTIVE',
        },
      });
      if (existing) {
        let code = '';
        if (existing.codeText) {
          try {
            code = decryptPairingCode(existing.codeText, this.config.pairingCodePepper);
          } catch {
            code = '';
          }
        }
        if (code) {
          return { pairingId: existing.id, code, expiresAt: null };
        }
      }

      // Generate a new Forever Code (uppercase alphanumeric)
      for (let attempt = 0; attempt < MAX_CODE_COLLISION_RETRY_ATTEMPTS; attempt++) {
        const code = generateForeverCode();
        try {
          const record = await this.prisma.pairingCode.create({
            data: {
              creatorUserId: userId,
              codeHmac: hashPairingCode(code, this.config.pairingCodePepper),
              codeText: encryptPairingCode(code, this.config.pairingCodePepper),
              expiresAt: null,
            },
          });
          return { pairingId: record.id, code, expiresAt: null };
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            const concurrent = await this.prisma.pairingCode.findFirst({
              where: { creatorUserId: userId, expiresAt: null, status: 'ACTIVE' },
            });
            if (concurrent && concurrent.codeText) {
              try {
                const dec = decryptPairingCode(concurrent.codeText, this.config.pairingCodePepper);
                return { pairingId: concurrent.id, code: dec, expiresAt: null };
              } catch {}
            }
            if (attempt < MAX_CODE_COLLISION_RETRY_ATTEMPTS - 1) continue;
          }
          throw err;
        }
      }
      throw new Error('Could not generate a unique Forever Code after repeated attempts — please retry.');
    }

    const expiresAt = computeExpiresAt(durationSeconds ?? null) ?? undefined;
    for (let attempt = 0; attempt < MAX_CODE_COLLISION_RETRY_ATTEMPTS; attempt++) {
      const code = generatePairingCode();
      try {
        const record = await this.prisma.pairingCode.create({
          data: {
            creatorUserId: userId,
            codeHmac: hashPairingCode(code, this.config.pairingCodePepper),
            codeText: encryptPairingCode(code, this.config.pairingCodePepper),
            expiresAt,
          },
        });
        return { pairingId: record.id, code, expiresAt: record.expiresAt };
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && attempt < MAX_CODE_COLLISION_RETRY_ATTEMPTS - 1) {
          continue;
        }
        throw err;
      }
    }
    throw new Error('Could not generate a unique pairing code after repeated attempts — please retry.');
  }

  async getActiveForeverCode(userId: string): Promise<{ code: string | null; createdAt?: Date }> {
    const record = await this.prisma.pairingCode.findFirst({
      where: {
        creatorUserId: userId,
        expiresAt: null,
        status: 'ACTIVE',
      },
    });
    if (!record || !record.codeText) {
      return { code: null };
    }
    try {
      const code = decryptPairingCode(record.codeText, this.config.pairingCodePepper);
      return { code, createdAt: record.createdAt };
    } catch {
      return { code: null };
    }
  }

  async revokeActiveForeverCode(userId: string): Promise<void> {
    const records = await this.prisma.pairingCode.findMany({
      where: {
        creatorUserId: userId,
        expiresAt: null,
        status: 'ACTIVE',
      },
    });
    if (records.length === 0) return;
    await this.prisma.pairingCode.updateMany({
      where: {
        creatorUserId: userId,
        expiresAt: null,
        status: 'ACTIVE',
      },
      data: { status: 'REVOKED' },
    });
    for (const r of records) {
      await this.prisma.securityEvent.create({
        data: { userId, eventType: 'PAIRING_REVOKED', metadata: { pairingId: r.id, foreverCode: true } },
      });
    }
  }

  async revoke(userId: string, pairingId: string) {
    const record = await this.prisma.pairingCode.findUnique({ where: { id: pairingId } });
    if (!record || record.creatorUserId !== userId) throw new NotFoundException('Not found');
    await this.prisma.pairingCode.update({ where: { id: pairingId }, data: { status: 'REVOKED' } });
    await this.prisma.securityEvent.create({ data: { userId, eventType: 'PAIRING_REVOKED', metadata: { pairingId } } });
  }

  async redeem(redeemerUserId: string, code: string) {
    const normalizedCode = normalizePairingCode(code);
    const candidates = await this.prisma.pairingCode.findMany({ where: { status: 'ACTIVE' } });
    const GENERIC_ERROR = 'Invalid or expired code';
    const match = candidates.find((c) => verifyPairingCode(normalizedCode, this.config.pairingCodePepper, c.codeHmac));

    if (!match) {
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

    const creatorDevice = await this.prisma.device.findFirst({
      where: { userId: match.creatorUserId, revokedAt: null },
      orderBy: { lastSeenAt: 'desc' },
    });
    if (!creatorDevice) throw new BadRequestException(GENERIC_ERROR);

    const isForeverCode = match.expiresAt === null;
    const { conversation, oneTimePrekey, creatorUser } = await this.prisma.$transaction(async (tx) => {
      if (!isForeverCode) {
        const updated = await tx.pairingCode.updateMany({
          where: { id: match.id, status: 'ACTIVE' },
          data: { status: 'USED', usedByUserId: redeemerUserId, usedAt: new Date() },
        });
        if (updated.count === 0) throw new BadRequestException(GENERIC_ERROR);
      } else {
        // Forever Code: permanently active and reusable until explicitly deleted by creator.
        // Record telemetry without rotating or retiring the code.
        await tx.pairingCode.update({
          where: { id: match.id },
          data: { usedByUserId: redeemerUserId, usedAt: new Date() },
        });
      }

      const [userAId, userBId] = canonicalPair(match.creatorUserId, redeemerUserId);

      // Check if conversation row already exists before create/update to prevent PostgreSQL 25P02 transaction abort
      const existing = await tx.conversation.findUnique({
        where: { userAId_userBId: { userAId, userBId } },
      });

      let conversation: Awaited<ReturnType<typeof tx.conversation.create>>;
      if (!existing) {
        conversation = await tx.conversation.create({ data: { userAId, userBId } });
      } else {
        if (existing.status === 'BLOCKED_BY_A' || existing.status === 'BLOCKED_BY_B') {
          throw new BadRequestException(GENERIC_ERROR);
        }
        conversation = await tx.conversation.update({
          where: { id: existing.id },
          data: {
            status: 'ACTIVE',
            disappearingTimerSeconds: null,
            disappearingTrigger: null,
            sessionEpoch: { increment: 1 },
          },
        });
      }

      const oneTimePrekey = await tx.oneTimePrekey.findFirst({
        where: { deviceId: creatorDevice.id, usedAt: null },
      });
      if (oneTimePrekey) {
        await tx.oneTimePrekey.update({ where: { id: oneTimePrekey.id }, data: { usedAt: new Date() } });
      }

      const creatorUser = await tx.user.findUnique({
        where: { id: match.creatorUserId },
        select: { id: true, username: true, displayName: true },
      });

      return { conversation, oneTimePrekey, creatorUser };
    });

    await this.prisma.securityEvent.createMany({
      data: [
        { userId: match.creatorUserId, eventType: 'NEW_PAIRING', metadata: { conversationId: conversation.id } },
        { userId: redeemerUserId, eventType: 'NEW_PAIRING', metadata: { conversationId: conversation.id } },
      ],
    });

    return {
      conversationId: conversation.id,
      sessionEpoch: conversation.sessionEpoch,
      bundle: {
        identityDhPublic: creatorDevice.identityDhPublic,
        identitySigningPublic: creatorDevice.identitySigningPublic,
        signedPrekeyPublic: creatorDevice.signedPrekeyPublic,
        signedPrekeySignature: creatorDevice.signedPrekeySignature,
        oneTimePrekeyPublic: oneTimePrekey?.publicKey,
      },
      otherUser: {
        id: creatorUser?.id ?? match.creatorUserId,
        username: creatorUser?.username ?? '',
        displayName: creatorUser?.displayName ?? null,
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
