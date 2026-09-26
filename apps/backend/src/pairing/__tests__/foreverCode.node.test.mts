import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateForeverCode,
  normalizePairingCode,
  encryptPairingCode,
  decryptPairingCode,
  hashPairingCode,
  verifyPairingCode,
  generatePairingCode,
} from '../../domain/pairingCode.ts';
import { PAIRING_DURATION_PRESETS_SECONDS } from '../../../dist/pairing/dto/pairing.dto.js';
import { PairingService } from '../../../dist/pairing/pairing.service.js';
import { ConversationsService } from '../../../dist/conversations/conversations.service.js';
import { BadRequestException } from '@nestjs/common';

const TEST_PEPPER = 'test-pepper-sufficiently-long-for-hmac-32-bytes!';

// --- DOMAIN CRYPTO TESTS ---
test('Forever Code: generation produces 9-char uppercase alphanumeric string', () => {
  const code1 = generateForeverCode();
  const code2 = generateForeverCode();
  assert.equal(code1.length, 9);
  assert.equal(code2.length, 9);
  assert.match(code1, /^[2-9A-Z]{9}$/);
  assert.notEqual(code1, code2);
});

test('Forever Code: normalization trims and uppercases code', () => {
  assert.equal(normalizePairingCode('  abc123xyz  '), 'ABC123XYZ');
  assert.equal(normalizePairingCode('123456'), '123456');
});

test('Forever Code: AES-256-GCM encryption and decryption round-trip', () => {
  const original = 'ABC123XYZ';
  const encrypted = encryptPairingCode(original, TEST_PEPPER);
  assert.ok(encrypted.includes(':'));
  assert.notEqual(encrypted, original);

  const decrypted = decryptPairingCode(encrypted, TEST_PEPPER);
  assert.equal(decrypted, original);
});

test('Forever Code: decryption fails on tampered or corrupted ciphertext', () => {
  const original = 'ABC123XYZ';
  const encrypted = encryptPairingCode(original, TEST_PEPPER);
  const parts = encrypted.split(':');
  const flippedByte = (parseInt(parts[1].slice(0, 2), 16) ^ 0xff).toString(16).padStart(2, '0');
  const tampered = parts[0] + ':' + flippedByte + parts[1].slice(2) + ':' + parts[2];
  assert.throws(() => decryptPairingCode(tampered, TEST_PEPPER));
});

test('Forever Code: hash and verification works case-insensitively and constant-time', () => {
  const code = 'ABC123XYZ';
  const hmac = hashPairingCode(code, TEST_PEPPER);
  assert.equal(verifyPairingCode('abc123xyz', TEST_PEPPER, hmac), true);
  assert.equal(verifyPairingCode('ABC123XYZ', TEST_PEPPER, hmac), true);
  assert.equal(verifyPairingCode('WRONGCODE', TEST_PEPPER, hmac), false);
});

// --- SERVICE TESTS: Idempotency, Persistence, Reusability, Burn Reconnect ---
function createMockPrisma() {
  const users = new Map([
    ['user-a', { id: 'user-a', username: 'alice', displayName: 'Alice A' }],
    ['user-b', { id: 'user-b', username: 'bob', displayName: 'Bob B' }],
  ]);
  const pairingCodes = new Map();
  const conversations = new Map();
  const devices = new Map([
    ['device-a', { id: 'device-a', userId: 'user-a', revokedAt: null, lastSeenAt: new Date(), identityDhPublic: 'dh-a', identitySigningPublic: 'sign-a', signedPrekeyPublic: 'spk-a', signedPrekeySignature: 'sig-a' }],
    ['device-b', { id: 'device-b', userId: 'user-b', revokedAt: null, lastSeenAt: new Date(), identityDhPublic: 'dh-b', identitySigningPublic: 'sign-b', signedPrekeyPublic: 'spk-b', signedPrekeySignature: 'sig-b' }],
  ]);
  const securityEvents = [];

  const mockPrisma = {
    user: {
      findUnique: async ({ where }: any) => users.get(where.id) || null,
    },
    pairingCode: {
      findFirst: async ({ where }: any) => {
        for (const code of pairingCodes.values()) {
          if (where.creatorUserId && code.creatorUserId !== where.creatorUserId) continue;
          if (where.status && code.status !== where.status) continue;
          if (where.expiresAt === null && (code.expiresAt !== null && code.expiresAt !== undefined)) continue;
          return code;
        }
        return null;
      },
      findMany: async ({ where }: any) => {
        const results = [];
        for (const code of pairingCodes.values()) {
          if (where.creatorUserId && code.creatorUserId !== where.creatorUserId) continue;
          if (where.status && code.status !== where.status) continue;
          if (where.expiresAt === null && (code.expiresAt !== null && code.expiresAt !== undefined)) continue;
          results.push(code);
        }
        return results;
      },
      findUnique: async ({ where }: any) => pairingCodes.get(where.id) || null,
      create: async ({ data }: any) => {
        const id = 'pc-' + Math.random().toString(36).slice(2);
        const record = {
          id,
          status: 'ACTIVE',
          expiresAt: null,
          failedAttempts: 0,
          lockedUntil: null,
          usedByUserId: null,
          usedAt: null,
          ...data,
          createdAt: new Date(),
        };
        pairingCodes.set(id, record);
        return record;
      },
      update: async ({ where, data }: any) => {
        const existing = pairingCodes.get(where.id);
        if (!existing) throw new Error('Not found');
        const updated = { ...existing, ...data };
        pairingCodes.set(where.id, updated);
        return updated;
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const [id, code] of pairingCodes.entries()) {
          if (where.id && code.id !== where.id) continue;
          if (where.creatorUserId && code.creatorUserId !== where.creatorUserId) continue;
          if (where.status && code.status !== where.status) continue;
          if (where.expiresAt === null && (code.expiresAt !== null && code.expiresAt !== undefined)) continue;
          pairingCodes.set(id, { ...code, ...data });
          count++;
        }
        return { count };
      },
    },
    conversation: {
      findUnique: async ({ where }: any) => {
        if (where.id) return conversations.get(where.id) || null;
        if (where.userAId_userBId) {
          const { userAId, userBId } = where.userAId_userBId;
          for (const c of conversations.values()) {
            if (c.userAId === userAId && c.userBId === userBId) return c;
          }
        }
        return null;
      },
      findMany: async ({ where }: any) => {
        const results = [];
        for (const c of conversations.values()) {
          const matchA = where.OR?.[0]?.userAId ? (c.userAId === where.OR[0].userAId || c.userBId === where.OR[1].userBId) : true;
          if (!matchA) continue;
          if (where.status?.not && c.status === where.status.not) continue;
          if (where.expiresAt?.lte && (!c.expiresAt || c.expiresAt > where.expiresAt.lte)) continue;
          const userA = users.get(c.userAId);
          const userB = users.get(c.userBId);
          results.push({ ...c, userA, userB });
        }
        return results;
      },
      create: async ({ data }: any) => {
        const id = 'conv-' + Math.random().toString(36).slice(2);
        const record = { id, ...data, status: 'ACTIVE', sessionEpoch: 1, createdAt: new Date() };
        conversations.set(id, record);
        return record;
      },
      update: async ({ where, data }: any) => {
        const existing = conversations.get(where.id);
        if (!existing) throw new Error('Not found');
        let sessionEpoch = existing.sessionEpoch;
        if (data.sessionEpoch?.increment) sessionEpoch += data.sessionEpoch.increment;
        const updated = { ...existing, ...data, sessionEpoch };
        conversations.set(where.id, updated);
        return updated;
      },
    },
    attachment: {
      deleteMany: async () => ({ count: 0 }),
    },
    message: {
      deleteMany: async () => ({ count: 0 }),
    },
    pendingHandshake: {
      deleteMany: async () => ({ count: 0 }),
    },
    device: {
      findFirst: async ({ where }: any) => {
        for (const d of devices.values()) {
          if (d.userId === where.userId && (where.revokedAt === null ? d.revokedAt === null : true)) return d;
        }
        return null;
      },
    },
    oneTimePrekey: {
      findFirst: async () => null,
      update: async () => {},
    },
    securityEvent: {
      create: async ({ data }: any) => { securityEvents.push(data); return data; },
      createMany: async ({ data }: any) => { securityEvents.push(...data); return { count: data.length }; },
    },
    $transaction: async (fnOrArray: any) => {
      if (typeof fnOrArray === 'function') {
        return fnOrArray(mockPrisma);
      }
      const results = [];
      for (const op of fnOrArray) results.push(await op);
      return results;
    },
  };

  return { mockPrisma, users, pairingCodes, conversations };
}

test('Forever Code: creation is idempotent and enforces single active code per user', async () => {
  const { mockPrisma } = createMockPrisma();
  const service = new PairingService(mockPrisma, { pairingCodePepper: TEST_PEPPER } as any);

  // First creation
  const first = await service.create('user-a', null);
  assert.ok(first.code);
  assert.equal(first.expiresAt, null);

  // Second creation: returns identical code
  const second = await service.create('user-a', null);
  assert.equal(second.code, first.code);
  assert.equal(second.pairingId, first.pairingId);

  // getActiveForeverCode returns the same code (survives refresh / session change)
  const active = await service.getActiveForeverCode('user-a');
  assert.equal(active.code, first.code);

  // User B has no active forever code yet (User isolation)
  const userBCode = await service.getActiveForeverCode('user-b');
  assert.equal(userBCode.code, null);
});

test('Forever Code: deletion invalidates code and allows fresh code creation', async () => {
  const { mockPrisma } = createMockPrisma();
  const service = new PairingService(mockPrisma, { pairingCodePepper: TEST_PEPPER } as any);

  const initial = await service.create('user-a', null);
  assert.ok(initial.code);

  // Delete active Forever Code
  await service.revokeActiveForeverCode('user-a');
  const activeAfterDelete = await service.getActiveForeverCode('user-a');
  assert.equal(activeAfterDelete.code, null);

  // Attempting to redeem deleted code fails
  await assert.rejects(
    () => service.redeem('user-b', initial.code),
    (err: any) => err instanceof BadRequestException && err.message === 'Invalid or expired code',
  );

  // Creating again after deletion generates a new active code
  const next = await service.create('user-a', null);
  assert.ok(next.code);
  assert.notEqual(next.code, initial.code);
});

test('Forever Code: redemption does NOT rotate or mark Forever Code as USED', async () => {
  const { mockPrisma } = createMockPrisma();
  const service = new PairingService(mockPrisma, { pairingCodePepper: TEST_PEPPER } as any);

  const codeData = await service.create('user-a', null);

  // User B redeems User A's Forever Code
  const redeemed = await service.redeem('user-b', codeData.code);
  assert.ok(redeemed.conversationId);
  assert.equal(redeemed.sessionEpoch, 1);
  assert.equal(redeemed.otherUser?.username, 'alice');

  // User A's Forever Code remains active and unchanged!
  const stillActive = await service.getActiveForeverCode('user-a');
  assert.equal(stillActive.code, codeData.code);

  // It can be redeemed again by another user or session without expiring
  const codeRecord = await mockPrisma.pairingCode.findUnique({ where: { id: codeData.pairingId } });
  assert.equal(codeRecord.status, 'ACTIVE');
});

test('Burn -> Reconnect: reconnecting with SAME Forever Code advances sessionEpoch and creates clean session without 500 error', async () => {
  const { mockPrisma, conversations } = createMockPrisma();
  const service = new PairingService(mockPrisma, { pairingCodePepper: TEST_PEPPER } as any);

  // Step 1: User A creates Forever Code
  const codeData = await service.create('user-a', null);

  // Step 2: User B connects
  const res1 = await service.redeem('user-b', codeData.code);
  assert.equal(res1.sessionEpoch, 1);
  const convId = res1.conversationId;

  // Step 3: Burn conversation (status becomes DELETED)
  conversations.get(convId).status = 'DELETED';

  // Step 4: User B connects AGAIN using the exact SAME Forever Code
  const res2 = await service.redeem('user-b', codeData.code);
  assert.equal(res2.conversationId, convId);
  // sessionEpoch is incremented to 2 for fresh session handshake
  assert.equal(res2.sessionEpoch, 2);

  // Conversation status is back to ACTIVE
  assert.equal(conversations.get(convId).status, 'ACTIVE');

  // Step 5: If User A blocks User B, reconnecting is blocked
  conversations.get(convId).status = 'BLOCKED_BY_A';
  await assert.rejects(
    () => service.redeem('user-b', codeData.code),
    (err: any) => err instanceof BadRequestException && err.message === 'Invalid or expired code',
  );
  // Status remains blocked
  assert.equal(conversations.get(convId).status, 'BLOCKED_BY_A');
});

test('Conversations: list and getStatus include authoritative participant username and displayName', async () => {
  const { mockPrisma, conversations } = createMockPrisma();
  const convService = new ConversationsService(mockPrisma, { pushToUser: () => {} } as any, { purgeDriveFilesForConversation: async () => {} } as any);

  conversations.set('conv-1', {
    id: 'conv-1',
    userAId: 'user-a',
    userBId: 'user-b',
    status: 'ACTIVE',
    sessionEpoch: 1,
    createdAt: new Date(),
    userA: { id: 'user-a', username: 'alice', displayName: 'Alice A' },
    userB: { id: 'user-b', username: 'bob', displayName: 'Bob B' },
  });

  // User A lists conversations: otherUser is User B
  const listA = await convService.list('user-a');
  assert.equal(listA.length, 1);
  assert.equal(listA[0].otherUser.username, 'bob');
  assert.equal(listA[0].otherUser.displayName, 'Bob B');

  // User B lists conversations: otherUser is User A
  const listB = await convService.list('user-b');
  assert.equal(listB.length, 1);
  assert.equal(listB[0].otherUser.username, 'alice');
  assert.equal(listB[0].otherUser.displayName, 'Alice A');

  // getStatus returns otherUser
  const statusA = await convService.getStatus('user-a', 'conv-1');
  assert.equal(statusA.otherUser.username, 'bob');

  const statusB = await convService.getStatus('user-b', 'conv-1');
  assert.equal(statusB.otherUser.username, 'alice');
});

// --- TEMPORARY CODE DURATION REGRESSION TESTS ---
test('Temporary Code Durations: PAIRING_DURATION_PRESETS_SECONDS contains all historical and new presets', () => {
  const expectedPresets = [
    5 * 60,
    15 * 60,
    30 * 60,
    60 * 60,
    6 * 60 * 60,
    12 * 60 * 60,
    24 * 60 * 60,
    7 * 24 * 60 * 60,
    30 * 24 * 60 * 60,
    90 * 24 * 60 * 60,
  ];
  for (const preset of expectedPresets) {
    assert.ok(
      PAIRING_DURATION_PRESETS_SECONDS.includes(preset as any),
      `Preset ${preset}s must be present in PAIRING_DURATION_PRESETS_SECONDS`,
    );
  }
});

test('Temporary Code: creation with 30-day and 90-day durations sets accurate expiration timestamps', async () => {
  const { mockPrisma } = createMockPrisma();
  const service = new PairingService(mockPrisma, { pairingCodePepper: TEST_PEPPER } as any);

  const before30d = Date.now() + 30 * 24 * 60 * 60 * 1000 - 2000;
  const res30d = await service.create('user-a', 30 * 24 * 60 * 60);
  const after30d = Date.now() + 30 * 24 * 60 * 60 * 1000 + 2000;

  assert.ok(res30d.code, 'Generates 30-day code');
  assert.ok(res30d.expiresAt, '30-day code has expiresAt');
  const exp30dTime = new Date(res30d.expiresAt).getTime();
  assert.ok(exp30dTime >= before30d && exp30dTime <= after30d, '30-day expiresAt is accurate');

  const before90d = Date.now() + 90 * 24 * 60 * 60 * 1000 - 2000;
  const res90d = await service.create('user-a', 90 * 24 * 60 * 60);
  const after90d = Date.now() + 90 * 24 * 60 * 60 * 1000 + 2000;

  assert.ok(res90d.code, 'Generates 90-day code');
  assert.ok(res90d.expiresAt, '90-day code has expiresAt');
  const exp90dTime = new Date(res90d.expiresAt).getTime();
  assert.ok(exp90dTime >= before90d && exp90dTime <= after90d, '90-day expiresAt is accurate');
});

test('Temporary Code: creation with 15m, 1h, 1d, 7d durations sets accurate expiration timestamps', async () => {
  const { mockPrisma } = createMockPrisma();
  const service = new PairingService(mockPrisma, { pairingCodePepper: TEST_PEPPER } as any);

  const durations = [
    { sec: 15 * 60, label: '15m' },
    { sec: 60 * 60, label: '1h' },
    { sec: 24 * 60 * 60, label: '1d' },
    { sec: 7 * 24 * 60 * 60, label: '7d' },
  ];

  for (const { sec, label } of durations) {
    const before = Date.now() + sec * 1000 - 2000;
    const res = await service.create('user-b', sec);
    const after = Date.now() + sec * 1000 + 2000;

    assert.ok(res.code, `Generates code for ${label}`);
    assert.ok(res.expiresAt, `Code for ${label} has expiresAt`);
    const expTime = new Date(res.expiresAt).getTime();
    assert.ok(expTime >= before && expTime <= after, `Expiration for ${label} is within expected range`);
  }
});

