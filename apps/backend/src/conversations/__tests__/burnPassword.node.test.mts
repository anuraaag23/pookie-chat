import test from 'node:test';
import assert from 'node:assert/strict';
import { UnauthorizedException } from '@nestjs/common';
import { ConversationsService } from '../../../dist/conversations/conversations.service.js';
import { RoomsService } from '../../../dist/rooms/rooms.service.js';
import { SettingsService } from '../../../dist/settings/settings.service.js';
import { hashPassword } from '../../domain/password.ts';

const PEPPER = 'test-pepper-sufficiently-long-for-hmac-32-bytes!';

function createTestHarness() {
  const users = new Map<string, any>();
  const userSettings = new Map<string, any>();
  const conversations = new Map<string, any>();
  const messages = new Map<string, any>();
  const attachments = new Map<string, any>();
  const rooms = new Map<string, any>();
  const roomMembers = new Map<string, any>();
  const roomJoinRequests = new Map<string, any>();
  const securityEvents: any[] = [];
  const emittedEvents: any[] = [];

  const mockRegistry = {
    pushToUser: (userId: string, event: string, payload: any) => {
      emittedEvents.push({ type: 'pushToUser', userId, event, payload });
      return true;
    },
    pushToUsers: (userIds: string[], event: string, payload: any) => {
      emittedEvents.push({ type: 'pushToUsers', userIds, event, payload });
      return userIds.length;
    },
    isOnline: () => true,
  };

  const mockAttachments = {
    purgeDriveFilesForConversation: async () => {},
    deleteForMessage: async () => {},
  };

  const mockPrisma: any = {
    user: {
      findUnique: async ({ where }: any) => users.get(where.id) || null,
    },
    userSettings: {
      findUnique: async ({ where }: any) => userSettings.get(where.userId) || null,
      create: async ({ data }: any) => {
        const record = { ...data, updatedAt: new Date() };
        userSettings.set(data.userId, record);
        return record;
      },
      update: async ({ where, data }: any) => {
        const existing = userSettings.get(where.userId) || { userId: where.userId };
        const updated = { ...existing, ...data, updatedAt: new Date() };
        userSettings.set(where.userId, updated);
        return updated;
      },
      upsert: async ({ where, create, update }: any) => {
        const existing = userSettings.get(where.userId);
        const updated = existing ? { ...existing, ...update } : { userId: where.userId, ...create };
        userSettings.set(where.userId, updated);
        return updated;
      },
    },
    conversation: {
      findUnique: async ({ where }: any) => conversations.get(where.id) || null,
      findFirst: async ({ where }: any) => {
        for (const c of conversations.values()) {
          if (where.id && c.id !== where.id) continue;
          if (where.status && c.status !== where.status) continue;
          return c;
        }
        return null;
      },
      update: async ({ where, data }: any) => {
        const c = conversations.get(where.id);
        if (c) {
          if (data.sessionEpoch?.increment) {
            c.sessionEpoch = (c.sessionEpoch || 0) + data.sessionEpoch.increment;
            delete data.sessionEpoch;
          }
          Object.assign(c, data);
        }
        return c;
      },
    },
    message: {
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
    },
    attachment: {
      deleteMany: async () => ({ count: 0 }),
    },
    pendingHandshake: {
      deleteMany: async () => ({ count: 0 }),
    },
    securityEvent: {
      createMany: async ({ data }: any) => securityEvents.push(...data),
    },
    room: {
      findUnique: async ({ where }: any) => {
        const r = rooms.get(where.id);
        return r ? { ...r, members: r.members || [] } : null;
      },
      update: async ({ where, data }: any) => {
        const r = rooms.get(where.id);
        if (r) Object.assign(r, data);
        return r;
      },
    },
    roomMember: {
      findUnique: async ({ where }: any) => {
        const key = `${where.roomId_userId?.roomId}:${where.roomId_userId?.userId}`;
        return roomMembers.get(key) || null;
      },
      findMany: async () => [],
      deleteMany: async () => ({ count: 0 }),
    },
    roomJoinRequest: {
      updateMany: async () => ({ count: 0 }),
    },
    roomKeyPackage: {
      deleteMany: async () => ({ count: 0 }),
    },
    roomMessage: {
      deleteMany: async () => ({ count: 0 }),
    },
    $transaction: async (fnOrArray: any) => {
      if (typeof fnOrArray === 'function') {
        return fnOrArray(mockPrisma);
      }
      return Promise.all(fnOrArray);
    },
  };

  const conversationsService = new ConversationsService(mockPrisma, mockRegistry as any, mockAttachments as any);
  const roomsService = new RoomsService(mockPrisma, { pairingCodePepper: PEPPER } as any, mockRegistry as any);
  const settingsService = new SettingsService(mockPrisma);

  return {
    mockPrisma,
    users,
    userSettings,
    conversations,
    rooms,
    roomMembers,
    conversationsService,
    roomsService,
    settingsService,
    emittedEvents,
  };
}

test('A) Correct Burn Password -> succeeds', async () => {
  const h = createTestHarness();
  const aliceId = 'user-alice';
  const bobId = 'user-bob';
  const convoId = 'convo-alice-bob';

  const burnPass = 'AliceBurnSecret123!';
  const accountPass = 'AliceAccountPassword456!';
  const burnHash = await hashPassword(burnPass);
  const accountHash = await hashPassword(accountPass);

  h.users.set(aliceId, { id: aliceId, username: 'alice', passwordHash: accountHash });
  h.users.set(bobId, { id: bobId, username: 'bob', passwordHash: 'bobAccountHash' });
  h.userSettings.set(aliceId, { userId: aliceId, burnPasswordHash: burnHash });

  h.conversations.set(convoId, {
    id: convoId,
    userAId: aliceId,
    userBId: bobId,
    status: 'ACTIVE',
    sessionEpoch: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // Burning with the correct Burn Password succeeds
  await h.conversationsService.burn(aliceId, convoId, burnPass);

  const convoAfter = h.conversations.get(convoId);
  assert.equal(convoAfter.status, 'DELETED');
  const burnedEvent = h.emittedEvents.find((e) => e.event === 'conversation_burned');
  assert.ok(burnedEvent);
  assert.equal(burnedEvent.userId, bobId);
});

test('B) Wrong Burn Password -> fails with UnauthorizedException', async () => {
  const h = createTestHarness();
  const aliceId = 'user-alice';
  const bobId = 'user-bob';
  const convoId = 'convo-alice-bob';

  const burnPass = 'AliceBurnSecret123!';
  const burnHash = await hashPassword(burnPass);

  h.users.set(aliceId, { id: aliceId, username: 'alice', passwordHash: 'someAccountHash' });
  h.userSettings.set(aliceId, { userId: aliceId, burnPasswordHash: burnHash });
  h.conversations.set(convoId, {
    id: convoId,
    userAId: aliceId,
    userBId: bobId,
    status: 'ACTIVE',
    sessionEpoch: 1,
  });

  // Attempt burn with wrong password
  await assert.rejects(
    () => h.conversationsService.burn(aliceId, convoId, 'WrongBurnPassword!'),
    (err: any) => err instanceof UnauthorizedException && err.message === 'Incorrect Burn Password',
  );

  // Conversation must remain ACTIVE
  const convoAfter = h.conversations.get(convoId);
  assert.equal(convoAfter.status, 'ACTIVE');
});

test('C) Account Password while Burn Password exists -> fails (no fallback)', async () => {
  const h = createTestHarness();
  const aliceId = 'user-alice';
  const bobId = 'user-bob';
  const convoId = 'convo-alice-bob';

  const burnPass = 'AliceBurnSecret123!';
  const accountPass = 'AliceAccountPassword456!';
  const burnHash = await hashPassword(burnPass);
  const accountHash = await hashPassword(accountPass);

  h.users.set(aliceId, { id: aliceId, username: 'alice', passwordHash: accountHash });
  h.userSettings.set(aliceId, { userId: aliceId, burnPasswordHash: burnHash });
  h.conversations.set(convoId, {
    id: convoId,
    userAId: aliceId,
    userBId: bobId,
    status: 'ACTIVE',
    sessionEpoch: 1,
  });

  // Supplying the user's valid account password must NOT authorize burn
  await assert.rejects(
    () => h.conversationsService.burn(aliceId, convoId, accountPass),
    (err: any) => err instanceof UnauthorizedException && err.message === 'Incorrect Burn Password',
  );

  // Conversation remains untouched
  assert.equal(h.conversations.get(convoId).status, 'ACTIVE');
});

test('D) First-time Burn -> setup -> burn succeeds', async () => {
  const h = createTestHarness();
  const charlieId = 'user-charlie';
  const bobId = 'user-bob';
  const convoId = 'convo-charlie-bob';

  h.users.set(charlieId, { id: charlieId, username: 'charlie', passwordHash: 'charlieAccountPass' });
  // No burn password configured initially
  h.userSettings.set(charlieId, { userId: charlieId, burnPasswordHash: null });
  h.conversations.set(convoId, {
    id: convoId,
    userAId: charlieId,
    userBId: bobId,
    status: 'ACTIVE',
    sessionEpoch: 1,
  });

  // Step 1: Trying to burn before setting up Burn Password is rejected
  await assert.rejects(
    () => h.conversationsService.burn(charlieId, convoId, 'anything'),
    (err: any) => err instanceof UnauthorizedException && err.message === 'Burn Password is not configured. Please set a Burn Password first.',
  );

  // Step 2: First-time setup flow (user creates Burn Password in modal)
  const setupRes = await h.settingsService.setFeaturePassword(charlieId, 'burn', 'CharlieFirstBurnPass!');
  assert.equal(setupRes.success, true);

  // Verify settings state now reflects configured
  const settingsStatus = await h.settingsService.get(charlieId);
  assert.equal(settingsStatus.hasBurnPassword, true);

  // Step 3: Action continues automatically with the new Burn Password
  await h.conversationsService.burn(charlieId, convoId, 'CharlieFirstBurnPass!');

  // Conversation is now burned
  assert.equal(h.conversations.get(convoId).status, 'DELETED');
});

test('E) Room Close with Burn Password -> succeeds with Burn Password, fails with wrong/account password', async () => {
  const h = createTestHarness();
  const ownerId = 'user-owner';
  const roomId = 'room-123';

  const burnPass = 'OwnerBurnPass123!';
  const accountPass = 'OwnerAccountPass456!';
  const burnHash = await hashPassword(burnPass);
  const accountHash = await hashPassword(accountPass);

  h.users.set(ownerId, { id: ownerId, username: 'owner', passwordHash: accountHash });
  h.userSettings.set(ownerId, { userId: ownerId, burnPasswordHash: burnHash });

  h.rooms.set(roomId, {
    id: roomId,
    name: 'Secure Room',
    ownerId,
    status: 'ACTIVE',
  });
  h.roomMembers.set(`${roomId}:${ownerId}`, {
    roomId,
    userId: ownerId,
    role: 'OWNER',
  });

  // 1. Wrong password fails
  await assert.rejects(
    () => h.roomsService.deleteRoom(ownerId, roomId, 'WrongPass!'),
    (err: any) => err instanceof UnauthorizedException && err.message === 'Incorrect Burn Password',
  );

  // 2. Account password fails (cannot substitute for Burn Password)
  await assert.rejects(
    () => h.roomsService.deleteRoom(ownerId, roomId, accountPass),
    (err: any) => err instanceof UnauthorizedException && err.message === 'Incorrect Burn Password',
  );

  // Room remains active
  assert.equal(h.rooms.get(roomId).status, 'ACTIVE');

  // 3. Correct Burn Password succeeds
  await h.roomsService.deleteRoom(ownerId, roomId, burnPass);
  assert.equal(h.rooms.get(roomId).status, 'DELETED');
});

test('F) Account Password cannot substitute for Burn, Lock, or Hide passwords', async () => {
  const h = createTestHarness();
  const userId = 'user-isolation-test';

  const accountPass = 'RealAccountPassword123!';
  const burnPass = 'FeatureBurnPass!';
  const lockPass = 'FeatureLockPass!';
  const hidePass = 'FeatureHidePass!';

  h.users.set(userId, {
    id: userId,
    username: 'isolated',
    passwordHash: await hashPassword(accountPass),
  });

  // Configure feature passwords
  await h.settingsService.setFeaturePassword(userId, 'burn', burnPass);
  await h.settingsService.setFeaturePassword(userId, 'lock', lockPass);
  await h.settingsService.setFeaturePassword(userId, 'hide', hidePass);

  // Verify feature password verification endpoints REJECT account password
  await assert.rejects(
    () => h.settingsService.verifyFeaturePassword(userId, 'burn', accountPass),
    (err: any) => err instanceof UnauthorizedException && err.message === 'Incorrect password',
  );

  await assert.rejects(
    () => h.settingsService.verifyFeaturePassword(userId, 'lock', accountPass),
    (err: any) => err instanceof UnauthorizedException && err.message === 'Incorrect password',
  );

  await assert.rejects(
    () => h.settingsService.verifyFeaturePassword(userId, 'hide', accountPass),
    (err: any) => err instanceof UnauthorizedException && err.message === 'Incorrect password',
  );

  // But feature passwords succeed on their respective endpoints
  const burnOk = await h.settingsService.verifyFeaturePassword(userId, 'burn', burnPass);
  const lockOk = await h.settingsService.verifyFeaturePassword(userId, 'lock', lockPass);
  const hideOk = await h.settingsService.verifyFeaturePassword(userId, 'hide', hidePass);

  assert.equal(burnOk.valid, true);
  assert.equal(lockOk.valid, true);
  assert.equal(hideOk.valid, true);

  // Cross-feature substitution also fails: lock password cannot verify burn, etc.
  await assert.rejects(
    () => h.settingsService.verifyFeaturePassword(userId, 'burn', lockPass),
    (err: any) => err instanceof UnauthorizedException,
  );
});
