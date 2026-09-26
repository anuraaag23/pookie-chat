import test from 'node:test';
import assert from 'node:assert/strict';
import { PairingService } from '../../../dist/pairing/pairing.service.js';
import { ConversationsService } from '../../../dist/conversations/conversations.service.js';
import { MessagesService } from '../../../dist/messages/messages.service.js';
import { AttachmentsService } from '../../../dist/attachments/attachments.service.js';
import { HandshakeService } from '../../../dist/handshake/handshake.service.js';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { hashPairingCode } from '../../domain/pairingCode.ts';

function createMockPrisma() {
  const users = new Map([
    ['user-creator', { id: 'user-creator', username: 'alice', displayName: 'Alice Creator' }],
    ['user-joiner', { id: 'user-joiner', username: 'bob', displayName: 'Bob Joiner' }],
  ]);
  const pairingCodes = new Map<string, any>();
  const conversations = new Map<string, any>();
  const messages = new Map<string, any>();
  const attachments = new Map<string, any>();
  const pendingHandshakes = new Map<string, any>();
  const securityEvents: any[] = [];

  const mockPrisma: any = {
    user: {
      findUnique: async ({ where }: any) => users.get(where.id) || null,
    },
    userSettings: {
      findUnique: async () => ({ lastSeenEnabled: true, readReceiptsEnabled: true, typingIndicatorEnabled: true }),
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
          if (where?.creatorUserId && code.creatorUserId !== where.creatorUserId) continue;
          if (where?.status && code.status !== where.status) continue;
          if (where?.expiresAt === null && (code.expiresAt !== null && code.expiresAt !== undefined)) continue;
          results.push(code);
        }
        return results;
      },
      create: async ({ data }: any) => {
        const record = { id: `code-${Date.now()}-${Math.random()}`, status: 'ACTIVE', failedAttempts: 0, lockedUntil: null, ...data };
        pairingCodes.set(record.id, record);
        return record;
      },
      update: async ({ where, data }: any) => {
        const item = pairingCodes.get(where.id);
        if (item) Object.assign(item, data);
        return item;
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const item of pairingCodes.values()) {
          if (where.id && item.id !== where.id) continue;
          if (where.status && item.status !== where.status) continue;
          Object.assign(item, data);
          count++;
        }
        return { count };
      },
    },
    conversation: {
      findUnique: async ({ where }: any) => {
        if (where.id) return conversations.get(where.id) || null;
        if (where.userAId_userBId) {
          for (const c of conversations.values()) {
            if (c.userAId === where.userAId_userBId.userAId && c.userBId === where.userAId_userBId.userBId) {
              return c;
            }
          }
        }
        return null;
      },
      findUniqueOrThrow: async ({ where }: any) => {
        const c = conversations.get(where.id);
        if (!c) throw new Error('Not found');
        return c;
      },
      findMany: async ({ where }: any) => {
        const list = Array.from(conversations.values());
        return list.filter((c) => {
          if (where?.status?.not && c.status === where.status.not) return false;
          if (where?.expiresAt?.lte && (!c.expiresAt || c.expiresAt > where.expiresAt.lte)) return false;
          if (where?.AND) {
            for (const cond of where.AND) {
              if (cond.status?.not && c.status === cond.status.not) return false;
              if (cond.OR) {
                const isExpiresCondition = cond.OR.some((o: any) => 'expiresAt' in o);
                if (isExpiresCondition) {
                  const matches = cond.OR.some((o: any) => {
                    if (o.expiresAt === null) return c.expiresAt === null;
                    if (o.expiresAt?.gt) return c.expiresAt && c.expiresAt > o.expiresAt.gt;
                    return false;
                  });
                  if (!matches) return false;
                }
              }
            }
          }
          return true;
        });
      },
      create: async ({ data }: any) => {
        const convo = {
          id: `convo-${Date.now()}-${Math.random()}`,
          status: 'ACTIVE',
          sessionEpoch: 1,
          createdAt: new Date(),
          userA: users.get(data.userAId),
          userB: users.get(data.userBId),
          ...data,
        };
        conversations.set(convo.id, convo);
        return convo;
      },
      update: async ({ where, data }: any) => {
        const convo = conversations.get(where.id);
        if (!convo) throw new Error('Not found');
        if (data.sessionEpoch?.increment) {
          convo.sessionEpoch += data.sessionEpoch.increment;
          delete data.sessionEpoch;
        }
        Object.assign(convo, data);
        return convo;
      },
    },
    message: {
      findUnique: async ({ where }: any) => {
        const m = messages.get(where.id);
        if (!m) return null;
        return { ...m, conversation: conversations.get(m.conversationId) };
      },
      findFirst: async ({ where }: any) => {
        for (const m of messages.values()) {
          if (where.id && m.id !== where.id) continue;
          if (where.conversationId && m.conversationId !== where.conversationId) continue;
          return { ...m, conversation: conversations.get(m.conversationId) };
        }
        return null;
      },
      findMany: async ({ where }: any) => {
        return Array.from(messages.values()).filter((m) => m.conversationId === where.conversationId);
      },
      deleteMany: async ({ where }: any) => {
        let count = 0;
        for (const [id, m] of messages.entries()) {
          if (m.conversationId === where.conversationId) {
            messages.delete(id);
            count++;
          }
        }
        return { count };
      },
      create: async ({ data }: any) => {
        const msg = { id: `msg-${Date.now()}-${Math.random()}`, ...data };
        messages.set(msg.id, msg);
        return msg;
      },
      update: async ({ where, data }: any) => {
        const m = messages.get(where.id);
        if (m) Object.assign(m, data);
        return m;
      },
      aggregate: async () => ({ _max: { sequenceNumber: BigInt(1), syncVersion: BigInt(1) } }),
    },
    attachment: {
      findUnique: async ({ where }: any) => {
        const a = attachments.get(where.id);
        if (!a) return null;
        const msg = a.messageId ? messages.get(a.messageId) : null;
        return {
          ...a,
          message: msg ? { ...msg, conversation: conversations.get(msg.conversationId) } : null,
        };
      },
      deleteMany: async ({ where }: any) => {
        let count = 0;
        for (const [id, a] of attachments.entries()) {
          if (a.conversationId === where.conversationId) {
            attachments.delete(id);
            count++;
          }
        }
        return { count };
      },
      create: async ({ data }: any) => {
        const att = { id: `att-${Date.now()}-${Math.random()}`, ...data };
        attachments.set(att.id, att);
        return att;
      },
      update: async ({ where, data }: any) => {
        const a = attachments.get(where.id);
        if (a) Object.assign(a, data);
        return a;
      },
    },
    pendingHandshake: {
      findUnique: async ({ where }: any) => pendingHandshakes.get(where.conversationId) || null,
      upsert: async ({ where, create, update }: any) => {
        const existing = pendingHandshakes.get(where.conversationId);
        const saved = existing ? { ...existing, ...update } : { ...create };
        pendingHandshakes.set(where.conversationId, saved);
        return saved;
      },
      deleteMany: async ({ where }: any) => {
        pendingHandshakes.delete(where.conversationId);
        return { count: 1 };
      },
    },
    oneTimePrekey: {
      findFirst: async () => null,
    },
    securityEvent: {
      createMany: async ({ data }: any) => securityEvents.push(...data),
    },
    $transaction: async (fnOrArray: any) => {
      if (typeof fnOrArray === 'function') {
        return fnOrArray(mockPrisma);
      }
      return Promise.all(fnOrArray);
    },
  };

  return { mockPrisma, users, pairingCodes, conversations, messages, attachments, pendingHandshakes };
}

function createMockRegistry() {
  const events: { userIds: string[]; event: string; payload: any }[] = [];
  return {
    events,
    pushToUser: (userId: string, event: string, payload: any) => {
      events.push({ userIds: [userId], event, payload });
      return true;
    },
    pushToUsers: (userIds: string[], event: string, payload: any) => {
      events.push({ userIds, event, payload });
      return userIds.length;
    },
    isOnline: () => true,
  };
}

function createMockAttachments() {
  return {
    purgeDriveFilesForConversation: async () => {},
    deleteForMessage: async () => {},
    resolveUserStorageProvider: async () => 'LOCAL',
    getStorageProvider: () => ({
      upload: async () => 'mock-drive-file-id',
      download: async () => Buffer.from('mock-bytes'),
    }),
  };
}

test('1. Temporary Pairing Code Redemption sets expiresAt and temporaryCreatorUserId', async () => {
  const { mockPrisma } = createMockPrisma();
  const mockConfig = { pairingCodePepper: 'test-pepper-sufficiently-long-for-hmac-32-bytes!' };
  const pairingService = new PairingService(mockPrisma, mockConfig as any);

  // Setup creator device
  const creatorDevice = {
    id: 'dev-creator',
    userId: 'user-creator',
    identityDhPublic: 'dhPub',
    identitySigningPublic: 'signPub',
    signedPrekeyPublic: 'spkPub',
    signedPrekeySignature: 'spkSig',
    revokedAt: null,
  };
  mockPrisma.device = { findFirst: async () => creatorDevice };

  // Create temporary code for 1 hour
  const expiresAt = new Date(Date.now() + 3600 * 1000);
  const codeRecord = await mockPrisma.pairingCode.create({
    data: {
      creatorUserId: 'user-creator',
      codeHmac: hashPairingCode('123456', mockConfig.pairingCodePepper),
      codeText: 'enc-1',
      expiresAt,
    },
  });

  const result = await pairingService.redeem('user-joiner', '123456');

  assert.ok(result.conversationId);
  assert.equal(result.isTemporary, true);
  assert.equal(result.expiresAt.getTime(), expiresAt.getTime());

  // Check saved conversation in DB
  const savedConvo = await mockPrisma.conversation.findUnique({ where: { id: result.conversationId } });
  assert.equal(savedConvo.expiresAt.getTime(), expiresAt.getTime());
  assert.equal(savedConvo.temporaryCreatorUserId, 'user-creator');
});

test('2. Forever Pairing Code Redemption sets expiresAt: null and temporaryCreatorUserId: null', async () => {
  const { mockPrisma } = createMockPrisma();
  const mockConfig = { pairingCodePepper: 'test-pepper-sufficiently-long-for-hmac-32-bytes!' };
  const pairingService = new PairingService(mockPrisma, mockConfig as any);

  const creatorDevice = {
    id: 'dev-creator',
    userId: 'user-creator',
    identityDhPublic: 'dhPub',
    identitySigningPublic: 'signPub',
    signedPrekeyPublic: 'spkPub',
    signedPrekeySignature: 'spkSig',
    revokedAt: null,
  };
  mockPrisma.device = { findFirst: async () => creatorDevice };

  // Forever code has expiresAt: null
  const codeRecord = await mockPrisma.pairingCode.create({
    data: {
      creatorUserId: 'user-creator',
      codeHmac: hashPairingCode('ABC123XYZ', mockConfig.pairingCodePepper),
      codeText: 'enc-forever',
      expiresAt: null,
    },
  });

  const result = await pairingService.redeem('user-joiner', 'ABC123XYZ');

  assert.equal(result.isTemporary, false);
  assert.equal(result.expiresAt, null);

  const savedConvo = await mockPrisma.conversation.findUnique({ where: { id: result.conversationId } });
  assert.equal(savedConvo.expiresAt, null);
  assert.equal(savedConvo.temporaryCreatorUserId, null);
});

test('3. Non-creator attempting to extend returns 403 Forbidden', async () => {
  const { mockPrisma } = createMockPrisma();
  const mockRegistry = createMockRegistry();
  const mockAttachments = createMockAttachments();
  const convosService = new ConversationsService(mockPrisma, mockRegistry as any, mockAttachments as any);

  const expiresAt = new Date(Date.now() + 3600 * 1000);
  const convo = await mockPrisma.conversation.create({
    data: {
      userAId: 'user-creator',
      userBId: 'user-joiner',
      expiresAt,
      temporaryCreatorUserId: 'user-creator',
    },
  });

  // Non-creator (user-joiner) attempts extension
  await assert.rejects(
    () => convosService.extendTemporaryChat('user-joiner', convo.id, 1800),
    (err: any) => err instanceof ForbiddenException && err.message.includes('Only the creator'),
  );
});

test('4. Creator extending valid temporary chat successfully increases expiresAt by durationSeconds', async () => {
  const { mockPrisma } = createMockPrisma();
  const mockRegistry = createMockRegistry();
  const mockAttachments = createMockAttachments();
  const convosService = new ConversationsService(mockPrisma, mockRegistry as any, mockAttachments as any);

  const initialExpiry = new Date(Date.now() + 3600 * 1000);
  const convo = await mockPrisma.conversation.create({
    data: {
      userAId: 'user-creator',
      userBId: 'user-joiner',
      expiresAt: initialExpiry,
      temporaryCreatorUserId: 'user-creator',
    },
  });

  const res = await convosService.extendTemporaryChat('user-creator', convo.id, 1800); // +30 mins
  assert.equal(res.ok, true);

  const expectedMs = initialExpiry.getTime() + 1800 * 1000;
  assert.equal(new Date(res.expiresAt).getTime(), expectedMs);

  const updatedConvo = await mockPrisma.conversation.findUnique({ where: { id: convo.id } });
  assert.equal(updatedConvo.expiresAt.getTime(), expectedMs);

  // Broadcast event verified
  const lastEvent = mockRegistry.events.find((e) => e.event === 'temporary_chat_expiry_updated');
  assert.ok(lastEvent);
  assert.deepEqual(lastEvent.userIds, ['user-creator', 'user-joiner']);
  assert.equal(lastEvent.payload.expiresAt, new Date(expectedMs).toISOString());
});

test('5. Extension beyond 90 days from now is rejected with 400 Bad Request', async () => {
  const { mockPrisma } = createMockPrisma();
  const mockRegistry = createMockRegistry();
  const mockAttachments = createMockAttachments();
  const convosService = new ConversationsService(mockPrisma, mockRegistry as any, mockAttachments as any);

  const initialExpiry = new Date(Date.now() + 3600 * 1000);
  const convo = await mockPrisma.conversation.create({
    data: {
      userAId: 'user-creator',
      userBId: 'user-joiner',
      expiresAt: initialExpiry,
      temporaryCreatorUserId: 'user-creator',
    },
  });

  // Attempting to add 91 days (exceeding 90 days total)
  const tooLong = 91 * 24 * 60 * 60;
  await assert.rejects(
    () => convosService.extendTemporaryChat('user-creator', convo.id, tooLong),
    (err: any) => err instanceof BadRequestException && err.message.includes('90 days'),
  );
});

test('6. Extension of already-expired conversation is rejected with 400 Bad Request', async () => {
  const { mockPrisma } = createMockPrisma();
  const mockRegistry = createMockRegistry();
  const mockAttachments = createMockAttachments();
  const convosService = new ConversationsService(mockPrisma, mockRegistry as any, mockAttachments as any);

  // Already expired 10 minutes ago
  const expiredDate = new Date(Date.now() - 600 * 1000);
  const convo = await mockPrisma.conversation.create({
    data: {
      userAId: 'user-creator',
      userBId: 'user-joiner',
      expiresAt: expiredDate,
      temporaryCreatorUserId: 'user-creator',
    },
  });

  await assert.rejects(
    () => convosService.extendTemporaryChat('user-creator', convo.id, 1800),
    (err: any) => err instanceof BadRequestException && err.message.includes('expired'),
  );
});

test('7. Extension of permanent conversation is rejected with 400 Bad Request', async () => {
  const { mockPrisma } = createMockPrisma();
  const mockRegistry = createMockRegistry();
  const mockAttachments = createMockAttachments();
  const convosService = new ConversationsService(mockPrisma, mockRegistry as any, mockAttachments as any);

  const convo = await mockPrisma.conversation.create({
    data: {
      userAId: 'user-creator',
      userBId: 'user-joiner',
      expiresAt: null,
      temporaryCreatorUserId: null,
    },
  });

  await assert.rejects(
    () => convosService.extendTemporaryChat('user-creator', convo.id, 1800),
    (err: any) => err instanceof BadRequestException && err.message.includes('permanent'),
  );
});

test('8. getStatus returns authoritative temporary fields and detects active vs expired', async () => {
  const { mockPrisma, messages } = createMockPrisma();
  const mockRegistry = createMockRegistry();
  const mockAttachments = createMockAttachments();
  const convosService = new ConversationsService(mockPrisma, mockRegistry as any, mockAttachments as any);

  // 1. Active conversation
  const futureExpiry = new Date(Date.now() + 3600 * 1000);
  const activeConvo = await mockPrisma.conversation.create({
    data: {
      userAId: 'user-creator',
      userBId: 'user-joiner',
      expiresAt: futureExpiry,
      temporaryCreatorUserId: 'user-creator',
    },
  });

  const creatorStatus = await convosService.getStatus('user-creator', activeConvo.id);
  assert.equal(creatorStatus.isTemporary, true);
  assert.equal(creatorStatus.isCreator, true);
  assert.equal(creatorStatus.isExpired, false);
  assert.equal(creatorStatus.expiresAt, futureExpiry.toISOString());

  const joinerStatus = await convosService.getStatus('user-joiner', activeConvo.id);
  assert.equal(joinerStatus.isTemporary, true);
  assert.equal(joinerStatus.isCreator, false);
  assert.equal(joinerStatus.isExpired, false);

  // 2. Expired conversation (now >= expiresAt)
  const pastExpiry = new Date(Date.now() - 5000);
  const expiredConvo = await mockPrisma.conversation.create({
    data: {
      userAId: 'user-creator',
      userBId: 'user-joiner',
      expiresAt: pastExpiry,
      temporaryCreatorUserId: 'user-creator',
    },
  });
  // Add a message in the expired convo
  await mockPrisma.message.create({
    data: { conversationId: expiredConvo.id, senderId: 'user-creator', ciphertext: Buffer.from('c'), nonce: Buffer.from('n') },
  });
  assert.equal(messages.size, 1);

  const expiredStatus = await convosService.getStatus('user-creator', expiredConvo.id);
  assert.equal(expiredStatus.isExpired, true);
  assert.equal(expiredStatus.status, 'DELETED');

  // Verify message wiped by internalExpireAndDestroy
  assert.equal(messages.size, 0);

  // Verify real-time socket event pushed
  const expiredEvent = mockRegistry.events.find((e) => e.event === 'temporary_chat_expired');
  assert.ok(expiredEvent);
  assert.deepEqual(expiredEvent.userIds, ['user-creator', 'user-joiner']);
});

test('9. list excludes expired conversations and triggers cleanup', async () => {
  const { mockPrisma } = createMockPrisma();
  const mockRegistry = createMockRegistry();
  const mockAttachments = createMockAttachments();
  const convosService = new ConversationsService(mockPrisma, mockRegistry as any, mockAttachments as any);

  // 1 active, 1 expired
  const activeConvo = await mockPrisma.conversation.create({
    data: {
      userAId: 'user-creator',
      userBId: 'user-joiner',
      expiresAt: new Date(Date.now() + 3600 * 1000),
      temporaryCreatorUserId: 'user-creator',
    },
  });

  const expiredConvo = await mockPrisma.conversation.create({
    data: {
      userAId: 'user-creator',
      userBId: 'user-joiner',
      expiresAt: new Date(Date.now() - 5000),
      temporaryCreatorUserId: 'user-creator',
    },
  });

  const list = await convosService.list('user-creator');
  assert.equal(list.length, 1);
  assert.equal(list[0].id, activeConvo.id);
  assert.equal(list[0].isTemporary, true);
  assert.equal(list[0].isCreator, true);

  // Verify expired convo status is now DELETED
  const checkExpired = await mockPrisma.conversation.findUnique({ where: { id: expiredConvo.id } });
  assert.equal(checkExpired.status, 'DELETED');
});

test('10. MessagesService blocks send on expired temporary conversation', async () => {
  const { mockPrisma } = createMockPrisma();
  const mockRegistry = createMockRegistry();
  const mockAttachments = createMockAttachments();
  const messagesService = new MessagesService(mockPrisma, mockRegistry as any, mockAttachments as any);

  const pastExpiry = new Date(Date.now() - 10000);
  const expiredConvo = await mockPrisma.conversation.create({
    data: {
      userAId: 'user-creator',
      userBId: 'user-joiner',
      expiresAt: pastExpiry,
      temporaryCreatorUserId: 'user-creator',
    },
  });

  await assert.rejects(
    () =>
      messagesService.send('user-creator', {
        conversationId: expiredConvo.id,
        clientMessageId: 'cli-1',
        ciphertext: 'cipher',
        iv: 'iv',
        messageType: 'TEXT',
        sessionEpoch: 1,
      }),
    (err: any) => err instanceof ForbiddenException && err.message.includes('expired'),
  );

  // Convo status flipped to DELETED
  const check = await mockPrisma.conversation.findUnique({ where: { id: expiredConvo.id } });
  assert.equal(check.status, 'DELETED');
});

test('11. MessagesService blocks editMessage and deleteMessage on expired conversation', async () => {
  const { mockPrisma } = createMockPrisma();
  const mockRegistry = createMockRegistry();
  const mockAttachments = createMockAttachments();
  const messagesService = new MessagesService(mockPrisma, mockRegistry as any, mockAttachments as any);

  const pastExpiry = new Date(Date.now() - 10000);
  const expiredConvo = await mockPrisma.conversation.create({
    data: {
      userAId: 'user-creator',
      userBId: 'user-joiner',
      expiresAt: pastExpiry,
      temporaryCreatorUserId: 'user-creator',
    },
  });

  const msg = await mockPrisma.message.create({
    data: {
      conversationId: expiredConvo.id,
      senderId: 'user-creator',
      ciphertext: Buffer.from('orig'),
      nonce: Buffer.from('orig-iv'),
    },
  });

  // editMessage blocked
  await assert.rejects(
    () => messagesService.editMessage('user-creator', msg.id, 'new-cipher', 'new-iv'),
    (err: any) => err instanceof ForbiddenException && err.message.includes('expired'),
  );

  const expiredConvo2 = await mockPrisma.conversation.create({
    data: {
      userAId: 'user-creator',
      userBId: 'user-joiner',
      expiresAt: pastExpiry,
      temporaryCreatorUserId: 'user-creator',
    },
  });

  const msg2 = await mockPrisma.message.create({
    data: {
      conversationId: expiredConvo2.id,
      senderId: 'user-creator',
      ciphertext: Buffer.from('orig2'),
      nonce: Buffer.from('orig2-iv'),
    },
  });

  // deleteMessage blocked
  await assert.rejects(
    () => messagesService.deleteMessage('user-creator', msg2.id),
    (err: any) => err instanceof ForbiddenException && err.message.includes('expired'),
  );
});

test('12. AttachmentsService blocks upload and download on expired conversation', async () => {
  const { mockPrisma } = createMockPrisma();
  const attachmentsService = new AttachmentsService(mockPrisma, {} as any);
  (attachmentsService as any).resolveUserStorageProvider = async () => 'LOCAL';
  (attachmentsService as any).getStorageProvider = () => ({
    upload: async () => 'file-id',
    download: async () => Buffer.from('data'),
  });

  const pastExpiry = new Date(Date.now() - 10000);
  const expiredConvo = await mockPrisma.conversation.create({
    data: {
      userAId: 'user-creator',
      userBId: 'user-joiner',
      expiresAt: pastExpiry,
      temporaryCreatorUserId: 'user-creator',
    },
  });

  // Upload blocked
  await assert.rejects(
    () => attachmentsService.upload('user-creator', expiredConvo.id, Buffer.from('bytes'), 'image', 5),
    (err: any) => err instanceof ForbiddenException && err.message.includes('expired'),
  );

  // Create an attachment with a message in this expired convo
  const msg = await mockPrisma.message.create({
    data: { conversationId: expiredConvo.id, senderId: 'user-creator', ciphertext: Buffer.alloc(0), nonce: Buffer.alloc(0) },
  });
  const att = await mockPrisma.attachment.create({
    data: {
      uploaderId: 'user-creator',
      conversationId: expiredConvo.id,
      messageId: msg.id,
      driveFileId: 'drv-1',
      storageProvider: 'LOCAL',
      mimeTypeHint: 'image',
      originalSize: 5,
      encryptedSize: 5,
    },
  });

  // Download blocked (returns 404 Not Found)
  await assert.rejects(
    () => attachmentsService.download('user-creator', att.id),
    (err: any) => err instanceof NotFoundException,
  );
});

test('13. HandshakeService blocks store and fetch on expired conversation', async () => {
  const { mockPrisma } = createMockPrisma();
  const handshakeService = new HandshakeService(mockPrisma);

  const pastExpiry = new Date(Date.now() - 10000);
  const expiredConvo = await mockPrisma.conversation.create({
    data: {
      userAId: 'user-creator',
      userBId: 'user-joiner',
      expiresAt: pastExpiry,
      temporaryCreatorUserId: 'user-creator',
    },
  });

  // Store rejected
  await assert.rejects(
    () => handshakeService.store('user-creator', expiredConvo.id, { dummy: 1 }, 1),
    (err: any) => err instanceof ForbiddenException,
  );

  // Fetch rejected
  await assert.rejects(
    () => handshakeService.fetch('user-joiner', expiredConvo.id),
    (err: any) => err instanceof NotFoundException,
  );
});

test('14. cleanupExpiredTemporaryChats background sweep cleans up expired chats and emits socket event', async () => {
  const { mockPrisma, messages } = createMockPrisma();
  const mockRegistry = createMockRegistry();
  const mockAttachments = createMockAttachments();
  const messagesService = new MessagesService(mockPrisma, mockRegistry as any, mockAttachments as any);

  const pastExpiry = new Date(Date.now() - 10000);
  const expiredConvo = await mockPrisma.conversation.create({
    data: {
      userAId: 'user-creator',
      userBId: 'user-joiner',
      expiresAt: pastExpiry,
      temporaryCreatorUserId: 'user-creator',
    },
  });

  await mockPrisma.message.create({
    data: { conversationId: expiredConvo.id, senderId: 'user-creator', ciphertext: Buffer.from('data'), nonce: Buffer.from('iv') },
  });
  assert.equal(messages.size, 1);

  const cleaned = await messagesService.cleanupExpiredTemporaryChats();
  assert.equal(cleaned, 1);

  // Message wiped
  assert.equal(messages.size, 0);

  // Status set to DELETED
  const check = await mockPrisma.conversation.findUnique({ where: { id: expiredConvo.id } });
  assert.equal(check.status, 'DELETED');

  // Socket event emitted to both participants
  const event = mockRegistry.events.find((e) => e.event === 'temporary_chat_expired');
  assert.ok(event);
  assert.deepEqual(event.userIds, ['user-creator', 'user-joiner']);
  assert.equal(event.payload.conversationId, expiredConvo.id);
});
