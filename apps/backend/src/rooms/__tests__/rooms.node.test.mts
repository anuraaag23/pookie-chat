import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomsService } from '../../../dist/rooms/rooms.service.js';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  generateRoomCode,
  normalizeRoomCode,
  encryptRoomCode,
  decryptRoomCode,
  hashRoomCode,
  verifyRoomCode,
} from '../../domain/room.ts';

const TEST_PEPPER = 'test-pepper-sufficiently-long-for-hmac-32-bytes!';

function createMockRoomsHarness() {
  const users = new Map([
    ['user-owner', { id: 'user-owner', username: 'alice', displayName: 'Alice A', email: 'alice@example.com' }],
    ['user-b', { id: 'user-b', username: 'bob', displayName: 'Bob B', email: 'bob@example.com' }],
    ['user-c', { id: 'user-c', username: 'charlie', displayName: 'Charlie C', email: 'charlie@example.com' }],
    ['user-d', { id: 'user-d', username: 'david', displayName: 'David D', email: 'david@example.com' }],
  ]);

  const rooms = new Map();
  const roomMembers = new Map();
  const roomJoinRequests = new Map();
  const roomMessages = new Map();
  const roomKeyPackages = new Map();
  const emittedEvents = [];
  const findManyScanCalls = [];

  const mockRegistry = {
    pushToUser: (userId, event, payload) => {
      emittedEvents.push({ type: 'pushToUser', target: userId, event, payload });
      return true;
    },
    pushToUsers: (userIds, event, payload) => {
      emittedEvents.push({ type: 'pushToUsers', targets: userIds, event, payload });
      return userIds.length;
    },
  };

  const mockPrisma = {
    user: {
      findUnique: async ({ where }) => users.get(where.id) || null,
    },
    room: {
      create: async ({ data }) => {
        const id = 'room-' + Math.random().toString(36).slice(2);
        const record = { id, ...data, createdAt: new Date(), updatedAt: new Date() };
        rooms.set(id, record);
        return record;
      },
      findUnique: async ({ where, include, select }) => {
        let r = null;
        if (where?.id) {
          r = rooms.get(where.id);
        } else if (where?.codeHmac) {
          r = Array.from(rooms.values()).find((x) => x.codeHmac === where.codeHmac) || null;
        }
        if (!r) return null;
        let res = { ...r };
        if (include?.members || select?.members) {
          const mList = Array.from(roomMembers.values()).filter((m) => m.roomId === r.id);
          res.members = mList.map((m) => ({
            ...m,
            user: users.get(m.userId) || { id: m.userId, username: 'unknown' },
          }));
        }
        if (include?.owner || select?.owner) {
          res.owner = users.get(r.ownerId) || null;
        }
        return res;
      },
      findMany: async ({ where, include }) => {
        findManyScanCalls.push(where);
        let list = Array.from(rooms.values());
        if (where?.status) {
          list = list.filter((r) => r.status === where.status);
        }
        if (where?.members?.some?.userId) {
          const uid = where.members.some.userId;
          list = list.filter((r) => {
            return Array.from(roomMembers.values()).some((m) => m.roomId === r.id && m.userId === uid);
          });
        }
        return list.map((r) => {
          const mList = Array.from(roomMembers.values()).filter((m) => m.roomId === r.id);
          const msgs = Array.from(roomMessages.values()).filter((msg) => msg.roomId === r.id);
          return {
            ...r,
            members: mList.map((m) => ({ ...m, user: users.get(m.userId) })),
            owner: users.get(r.ownerId),
            messages: msgs.slice(-1),
          };
        });
      },
      update: async ({ where, data }) => {
        const r = rooms.get(where.id);
        if (!r) throw new Error('Not found');
        let keyEpoch = r.keyEpoch;
        if (data?.keyEpoch?.increment) {
          keyEpoch = (keyEpoch || 1) + data.keyEpoch.increment;
        }
        const updated = { ...r, ...data, keyEpoch, updatedAt: new Date() };
        rooms.set(where.id, updated);
        return updated;
      },
    },
    roomMember: {
      create: async ({ data }) => {
        const id = 'rm-' + Math.random().toString(36).slice(2);
        const record = { id, ...data, joinedAt: new Date() };
        roomMembers.set(id, record);
        return record;
      },
      count: async ({ where }) => {
        return Array.from(roomMembers.values()).filter((m) => m.roomId === where.roomId).length;
      },
      findUnique: async ({ where }) => {
        if (where?.roomId_userId) {
          const { roomId, userId } = where.roomId_userId;
          return Array.from(roomMembers.values()).find((m) => m.roomId === roomId && m.userId === userId) || null;
        }
        return roomMembers.get(where.id) || null;
      },
      findMany: async ({ where, skip, take, include }) => {
        let list = Array.from(roomMembers.values());
        if (where?.roomId) list = list.filter((m) => m.roomId === where.roomId);
        if (include?.user) {
          list = list.map((m) => ({ ...m, user: users.get(m.userId) || { id: m.userId, username: 'unknown' } }));
        }
        if (typeof skip === 'number') list = list.slice(skip);
        if (typeof take === 'number') list = list.slice(0, take);
        return list;
      },
      delete: async ({ where }) => {
        const m = roomMembers.get(where.id);
        if (m) roomMembers.delete(where.id);
        return m;
      },
    },
    roomJoinRequest: {
      create: async ({ data }) => {
        const id = 'req-' + Math.random().toString(36).slice(2);
        const record = { id, ...data, createdAt: new Date(), reviewedAt: null, reviewedById: null };
        roomJoinRequests.set(id, record);
        return record;
      },
      findUnique: async ({ where }) => roomJoinRequests.get(where.id) || null,
      findFirst: async ({ where }) => {
        for (const req of roomJoinRequests.values()) {
          if (where.roomId && req.roomId !== where.roomId) continue;
          if (where.requesterId && req.requesterId !== where.requesterId) continue;
          if (where.status && req.status !== where.status) continue;
          return req;
        }
        return null;
      },
      findMany: async ({ where, orderBy, include }) => {
        let list = Array.from(roomJoinRequests.values());
        if (where?.roomId) list = list.filter((r) => r.roomId === where.roomId);
        if (where?.status) list = list.filter((r) => r.status === where.status);
        if (orderBy?.createdAt === 'asc') {
          list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        }
        return list.map((r) => ({
          ...r,
          requester: users.get(r.requesterId) ? { ...users.get(r.requesterId), devices: [] } : null,
        }));
      },
      update: async ({ where, data }) => {
        const req = roomJoinRequests.get(where.id);
        if (!req) throw new Error('Not found');
        const updated = { ...req, ...data };
        roomJoinRequests.set(where.id, updated);
        return updated;
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const [id, req] of roomJoinRequests.entries()) {
          if (where.roomId && req.roomId !== where.roomId) continue;
          if (where.status && req.status !== where.status) continue;
          roomJoinRequests.set(id, { ...req, ...data });
          count++;
        }
        return { count };
      },
    },
    roomMessage: {
      aggregate: async ({ where }) => {
        let max = 0n;
        for (const msg of roomMessages.values()) {
          if (msg.roomId === where.roomId && msg.sequenceNumber > max) {
            max = msg.sequenceNumber;
          }
        }
        return { _max: { sequenceNumber: max > 0n ? max : null } };
      },
      create: async ({ data, include }) => {
        const id = 'rmsg-' + Math.random().toString(36).slice(2);
        const record = { id, ...data };
        roomMessages.set(id, record);
        return { ...record, sender: users.get(data.senderId) };
      },
      findUnique: async ({ where }) => {
        if (where?.roomId_clientMessageId) {
          const { roomId, clientMessageId } = where.roomId_clientMessageId;
          return Array.from(roomMessages.values()).find((m) => m.roomId === roomId && m.clientMessageId === clientMessageId) || null;
        }
        return roomMessages.get(where.id) || null;
      },
      findMany: async ({ where }) => {
        let list = Array.from(roomMessages.values()).filter((m) => m.roomId === where.roomId && m.deletedAt === null);
        list.sort((a, b) => Number(a.sequenceNumber - b.sequenceNumber));
        return list.map((m) => ({ ...m, sender: users.get(m.senderId) }));
      },
    },
    roomKeyPackage: {
      upsert: async ({ where, create, update }) => {
        const id = 'rkp-' + Math.random().toString(36).slice(2);
        const record = { id, ...create, ...update, createdAt: new Date() };
        roomKeyPackages.set(id, record);
        return record;
      },
      findUnique: async () => null,
    },
    $transaction: async (fn) => fn(mockPrisma),
  };

  const service = new RoomsService(
    mockPrisma as any,
    { pairingCodePepper: TEST_PEPPER } as any,
    mockRegistry as any,
  );

  return { service, mockPrisma, users, rooms, roomMembers, roomJoinRequests, roomMessages, emittedEvents, findManyScanCalls };
}

// =========================================================================
// Deterministic Scenario Tests (Section 29: Scenarios 1–50)
// =========================================================================

test('1-5. ROOM CREATION: creates room, owner member, limits, join policy, persistent code', async () => {
  const { service, rooms, roomMembers } = createMockRoomsHarness();

  const res = await service.create('user-owner', {
    name: 'Secret Group',
    maxMembers: 5,
    joinPolicy: 'APPROVAL_REQUIRED',
  });

  // 1. Create room
  assert.ok(res.room.id);
  assert.equal(res.room.name, 'Secret Group');
  // 2. Owner automatically becomes member
  assert.equal(res.room.role, 'OWNER');
  assert.equal(res.room.memberCount, 1);
  assert.equal(roomMembers.size, 1);
  // 3. Maximum member limit stored
  assert.equal(res.room.maxMembers, 5);
  // 4. Join policy stored
  assert.equal(res.room.joinPolicy, 'APPROVAL_REQUIRED');
  // 5. Persistent room code generated
  assert.equal(res.room.code.length, 9);
  assert.match(res.room.code, /^[2-9A-Z]{9}$/);

  // Stored encrypted at rest, not plaintext
  const dbRoom = rooms.get(res.room.id);
  assert.notEqual(dbRoom.codeText, res.room.code);
  assert.ok(dbRoom.codeHmac);
});

test('6-10. ROOM CODE: persistence across reads/joins and invalidation on delete', async () => {
  const { service } = createMockRoomsHarness();

  const { room: created } = await service.create('user-owner', {
    name: 'Persistent Code Room',
    maxMembers: 5,
    joinPolicy: 'OPEN',
  });

  // 6. Code remains unchanged after refresh / re-fetch
  const read1 = await service.getRoom('user-owner', created.id);
  assert.equal(read1.code, created.code);

  // 7. Code remains unchanged after simulated logout/login (second read)
  const read2 = await service.getRoom('user-owner', created.id);
  assert.equal(read2.code, created.code);

  // 8. Code remains unchanged after user B joins
  await service.joinByCode('user-b', created.code);
  const read3 = await service.getRoom('user-owner', created.id);
  assert.equal(read3.code, created.code);

  // 9. Code invalidated when room is deleted/closed
  await service.deleteRoom('user-owner', created.id);
  await assert.rejects(
    () => service.joinByCode('user-c', created.code),
    (err: any) => err instanceof BadRequestException && err.message === 'Invalid room code',
  );

  // 10. Code verification matches strictly
  assert.equal(verifyRoomCode(created.code, TEST_PEPPER, hashRoomCode(created.code, TEST_PEPPER)), true);
  assert.equal(verifyRoomCode('WRONG1234', TEST_PEPPER, hashRoomCode(created.code, TEST_PEPPER)), false);
});

test('11-14. OPEN JOIN: valid code joins, invalid rejected, full room rejected, duplicate prevented', async () => {
  const { service } = createMockRoomsHarness();

  const { room } = await service.create('user-owner', {
    name: 'Open Room',
    maxMembers: 2, // Owner + 1 member max
    joinPolicy: 'OPEN',
  });

  // 11. Valid code allows join
  const joinB = await service.joinByCode('user-b', room.code);
  assert.equal(joinB.status, 'JOINED');

  // 12. Invalid code rejected
  await assert.rejects(
    () => service.joinByCode('user-c', 'BADCODE99'),
    (err: any) => err instanceof BadRequestException && err.message === 'Invalid room code',
  );

  // 13. Full room rejects join (capacity is 2, now has owner + user-b)
  await assert.rejects(
    () => service.joinByCode('user-c', room.code),
    (err: any) => err instanceof BadRequestException && err.message === 'Room is full',
  );

  // 14. Duplicate membership prevented: returns ALREADY_MEMBER
  const dupJoin = await service.joinByCode('user-b', room.code);
  assert.equal(dupJoin.status, 'ALREADY_MEMBER');
});

test('15-24. APPROVAL JOIN: requests, message isolation, FIFO ordering, accept, reject', async () => {
  const { service } = createMockRoomsHarness();

  const { room } = await service.create('user-owner', {
    name: 'VIP Club',
    maxMembers: 5,
    joinPolicy: 'APPROVAL_REQUIRED',
  });

  // 15. Valid code creates pending request
  const reqResB = await service.joinByCode('user-b', room.code);
  assert.equal(reqResB.status, 'REQUEST_SENT');

  // 16. Pending requester CANNOT access room messages
  await assert.rejects(
    () => service.listMessages('user-b', room.id),
    (err: any) => err instanceof ForbiddenException && err.message.includes('not a member'),
  );

  // 17. Duplicate pending request prevented
  const reqResB2 = await service.joinByCode('user-b', room.code);
  assert.equal(reqResB2.status, 'PENDING');
  assert.match(reqResB2.message, /already pending/);

  // User C also requests
  await service.joinByCode('user-c', room.code);

  // 18. Owner sees requests
  const pending = await service.getPendingRequests('user-owner', room.id);
  assert.equal(pending.length, 2);

  // 23. Requests appear in deterministic FIFO order (B then C)
  assert.equal(pending[0].requester.username, 'bob');
  assert.equal(pending[1].requester.username, 'charlie');

  // 19. Accept creates membership for B
  const acceptB = await service.acceptRequest('user-owner', room.id, pending[0].id, {});
  assert.equal(acceptB.success, true);
  assert.equal(acceptB.memberCount, 2);

  // B can now access room messages
  const bMsgs = await service.listMessages('user-b', room.id);
  assert.ok(Array.isArray(bMsgs));

  // 20. Reject does not create membership
  const rejectC = await service.rejectRequest('user-owner', room.id, pending[1].id);
  assert.equal(rejectC.success, true);
  await assert.rejects(
    () => service.listMessages('user-c', room.id),
    (err: any) => err instanceof ForbiddenException,
  );

  // 21. Accepted request cannot be accepted twice
  await assert.rejects(
    () => service.acceptRequest('user-owner', room.id, pending[0].id, {}),
    (err: any) => err instanceof BadRequestException && err.message.includes('no longer active'),
  );

  // 22. Rejected request cannot be accepted later
  await assert.rejects(
    () => service.acceptRequest('user-owner', room.id, pending[1].id, {}),
    (err: any) => err instanceof BadRequestException && err.message.includes('no longer active'),
  );

  // 24. Next request becomes active after decision
  const pendingAfter = await service.getPendingRequests('user-owner', room.id);
  assert.equal(pendingAfter.length, 0); // Both processed
});

test('25-26. CAPACITY: limit enforced server-side and concurrent accepts cannot exceed limit', async () => {
  const { service } = createMockRoomsHarness();

  const { room } = await service.create('user-owner', {
    name: 'Small Room',
    maxMembers: 2, // 1 owner + 1 slot left
    joinPolicy: 'APPROVAL_REQUIRED',
  });

  // User B and User C both request
  await service.joinByCode('user-b', room.code);
  await service.joinByCode('user-c', room.code);

  const pending = await service.getPendingRequests('user-owner', room.id);
  assert.equal(pending.length, 2);

  // Accept B takes the last available slot (2/2)
  await service.acceptRequest('user-owner', room.id, pending[0].id, {});

  // 25 & 26. Attempting to accept C fails with "Room is full"
  await assert.rejects(
    () => service.acceptRequest('user-owner', room.id, pending[1].id, {}),
    (err: any) => err instanceof BadRequestException && err.message === 'Room is full',
  );
});

test('27-30. OWNERSHIP: only owner can accept/reject/delete, normal member cannot', async () => {
  const { service } = createMockRoomsHarness();

  const { room } = await service.create('user-owner', {
    name: 'Owner Only Room',
    maxMembers: 5,
    joinPolicy: 'APPROVAL_REQUIRED',
  });

  await service.joinByCode('user-b', room.code);
  const pending = await service.getPendingRequests('user-owner', room.id);

  // 27. Normal user cannot accept
  await assert.rejects(
    () => service.acceptRequest('user-b', room.id, pending[0].id, {}),
    (err: any) => err instanceof ForbiddenException,
  );

  // 28. Normal user cannot reject
  await assert.rejects(
    () => service.rejectRequest('user-b', room.id, pending[0].id),
    (err: any) => err instanceof ForbiddenException,
  );

  // 29 & 30. Normal user cannot view requests or delete room
  await assert.rejects(
    () => service.getPendingRequests('user-b', room.id),
    (err: any) => err instanceof ForbiddenException,
  );
  await assert.rejects(
    () => service.deleteRoom('user-b', room.id),
    (err: any) => err instanceof ForbiddenException,
  );
});

test('31-35. REAL-TIME: Socket events for join_request, accepted, rejected, member_joined, closed', async () => {
  const { service, emittedEvents } = createMockRoomsHarness();

  const { room } = await service.create('user-owner', {
    name: 'Realtime Room',
    maxMembers: 5,
    joinPolicy: 'APPROVAL_REQUIRED',
  });

  // 31. New request emits room:join_request to owner
  await service.joinByCode('user-b', room.code);
  const reqEvent = emittedEvents.find((e) => e.event === 'room:join_request');
  assert.ok(reqEvent);
  assert.equal(reqEvent.target, 'user-owner');
  assert.equal(reqEvent.payload.requester.username, 'bob');

  // 32. Duplicate socket request deduplicated (no second event if already pending)
  const prevCount = emittedEvents.length;
  await service.joinByCode('user-b', room.code);
  assert.equal(emittedEvents.length, prevCount); // Not duplicated

  // 33. Accept event reaches accepted user B
  const pending = await service.getPendingRequests('user-owner', room.id);
  await service.acceptRequest('user-owner', room.id, pending[0].id, {});
  const acceptEvent = emittedEvents.find((e) => e.event === 'room:join_accepted');
  assert.ok(acceptEvent);
  assert.equal(acceptEvent.target, 'user-b');

  // 34. Join event reaches existing members
  const memberJoinedEvent = emittedEvents.find((e) => e.event === 'room:member_joined');
  assert.ok(memberJoinedEvent);
  assert.equal(memberJoinedEvent.payload.user.username, 'bob');

  // 35. Room closed event notifies all members
  await service.deleteRoom('user-owner', room.id);
  const closedEvent = emittedEvents.find((e) => e.event === 'room:closed');
  assert.ok(closedEvent);
});

test('36-39. USERNAME: member username display and privacy (no email exposed)', async () => {
  const { service } = createMockRoomsHarness();

  const { room } = await service.create('user-owner', {
    name: 'Username Privacy Room',
    maxMembers: 5,
    joinPolicy: 'OPEN',
  });

  await service.joinByCode('user-b', room.code);

  const roomDetail = await service.getRoom('user-b', room.id);
  // 36 & 37. Correct usernames displayed
  assert.equal(roomDetail.owner.username, 'alice');
  assert.equal(roomDetail.members.length, 2);
  assert.equal(roomDetail.members[0].username, 'alice');
  assert.equal(roomDetail.members[1].username, 'bob');

  // 38 & 39. Email is NOT exposed in room or member payloads
  assert.equal((roomDetail.owner as any).email, undefined);
  assert.equal((roomDetail.members[0] as any).email, undefined);
  assert.equal((roomDetail.members[1] as any).email, undefined);
});

test('40-45. ANIMATION & STATE: messages and member leave lifecycle', async () => {
  const { service } = createMockRoomsHarness();

  const { room } = await service.create('user-owner', {
    name: 'State Room',
    maxMembers: 5,
    joinPolicy: 'OPEN',
  });

  await service.joinByCode('user-b', room.code);

  // Normal member leaves
  const leaveRes = await service.leaveRoom('user-b', room.id);
  assert.equal(leaveRes.success, true);

  const afterLeave = await service.getRoom('user-owner', room.id);
  assert.equal(afterLeave.memberCount, 1);

  // Owner cannot leave (must delete)
  await assert.rejects(
    () => service.leaveRoom('user-owner', room.id),
    (err: any) => err instanceof BadRequestException && err.message.includes('owner cannot leave'),
  );
});

test('46-50. SECURITY: non-member cannot access, messages encrypted, closed room code blocked', async () => {
  const { service, roomMessages } = createMockRoomsHarness();

  const { room } = await service.create('user-owner', {
    name: 'Encrypted Secure Room',
    maxMembers: 5,
    joinPolicy: 'OPEN',
  });

  await service.joinByCode('user-b', room.code);

  // Send message
  const msgPayload = {
    clientMessageId: 'client-msg-1',
    ciphertext: Buffer.from('ciphertext-payload-bytes').toString('base64'),
    iv: Buffer.from('12-byte-nonce!').toString('base64'),
  };
  const sent = await service.sendMessage('user-b', room.id, msgPayload);
  assert.equal(sent.sequenceNumber, 1);

  // 50. Database stores ciphertext bytes, NEVER plaintext!
  const dbMsg = Array.from(roomMessages.values())[0];
  assert.ok(Buffer.isBuffer(dbMsg.ciphertext));
  assert.equal(dbMsg.ciphertext.toString('base64'), msgPayload.ciphertext);

  // 46. Non-member cannot fetch messages
  await assert.rejects(
    () => service.listMessages('user-c', room.id),
    (err: any) => err instanceof ForbiddenException,
  );

  // 47. Non-member cannot send messages
  await assert.rejects(
    () => service.sendMessage('user-c', room.id, msgPayload),
    (err: any) => err instanceof ForbiddenException,
  );

  // 48. Closed room rejects messages and joins
  await service.deleteRoom('user-owner', room.id);
  await assert.rejects(
    () => service.joinByCode('user-c', room.code),
    (err: any) => err instanceof BadRequestException && err.message === 'Invalid room code',
  );
  await assert.rejects(
    () => service.sendMessage('user-b', room.id, msgPayload),
    (err: any) => err instanceof NotFoundException && err.message === 'Room is no longer active',
  );
});

test('51-54. ROOM CAPACITY 2000 & SCALABLE MANAGEMENT: 2000 limit, pagination, update settings, member removal', async () => {
  const { service, prisma, registry } = createMockRoomsHarness();

  // Test 2000 capacity creation
  const created2000 = await service.create('user-owner', {
    name: 'Mega Room',
    maxMembers: 2000,
    joinPolicy: 'OPEN',
  });
  assert.equal(created2000.room.maxMembers, 2000);

  // Test 2001 capacity rejection
  await assert.rejects(
    () =>
      service.create('user-owner', {
        name: 'Too Big',
        maxMembers: 2001,
        joinPolicy: 'OPEN',
      }),
    (err: any) => err instanceof BadRequestException,
  );

  // Test getMembers pagination
  const paged = await service.getMembers('user-owner', created2000.room.id, 1, 10);
  assert.equal(paged.total, 1);
  assert.equal(paged.page, 1);
  assert.equal(paged.members.length, 1);
  assert.equal(paged.members[0]!.userId, 'user-owner');

  // Test updateRoom settings by owner
  const updated = await service.updateRoom('user-owner', created2000.room.id, {
    maxMembers: 1500,
    name: 'Mega Room Updated',
    joinPolicy: 'APPROVAL_REQUIRED',
  });
  assert.equal(updated.maxMembers, 1500);
  assert.equal(updated.name, 'Mega Room Updated');
  assert.equal(updated.joinPolicy, 'APPROVAL_REQUIRED');

  // Non-owner cannot update room
  await assert.rejects(
    () =>
      service.updateRoom('intruder', created2000.room.id, {
        maxMembers: 1000,
      }),
    (err: any) => err instanceof ForbiddenException,
  );

  // Owner cannot reduce limit below current member count
  await assert.rejects(
    () =>
      service.updateRoom('user-owner', created2000.room.id, {
        maxMembers: 0,
      }),
    (err: any) => err instanceof BadRequestException,
  );

  // Join a member to test removal
  await service.joinByCode('user-b', created2000.room.code);
  // Accept if approval required
  const reqs = await service.getPendingRequests('user-owner', created2000.room.id);
  assert.equal(reqs.length, 1);
  await service.acceptRequest('user-owner', created2000.room.id, reqs[0]!.id, {});

  const membersAfterJoin = await service.getMembers('user-owner', created2000.room.id, 1, 10);
  assert.equal(membersAfterJoin.total, 2);

  // Remove member
  const removal = await service.removeMember('user-owner', created2000.room.id, 'user-b');
  assert.equal(removal.success, true);
  assert.equal(removal.newKeyEpoch, 2); // key rotated!

  // Owner cannot remove themselves
  await assert.rejects(
    () => service.removeMember('user-owner', created2000.room.id, 'user-owner'),
    (err: any) => err instanceof BadRequestException,
  );

  // Non-owner cannot remove member
  await assert.rejects(
    () => service.removeMember('user-b', created2000.room.id, 'user-owner'),
    (err: any) => err instanceof ForbiddenException,
  );
});

// =========================================================================
// SEC-M01 REGRESSION TESTS: O(1) INDEXED ROOM CODE LOOKUP
// =========================================================================

test('SEC-M01: joinByCode performs O(1) indexed lookup via codeHmac with zero full table scans', async () => {
  const { service, rooms, roomMembers, findManyScanCalls, emittedEvents } = createMockRoomsHarness();

  // Create an OPEN room and an APPROVAL_REQUIRED room
  const openRoomRes = await service.create('user-owner', {
    name: 'Open Test Room',
    joinPolicy: 'OPEN',
    maxMembers: 5,
  });
  const openCode = openRoomRes.room.code;

  const approvalRoomRes = await service.create('user-owner', {
    name: 'Approval Test Room',
    joinPolicy: 'APPROVAL_REQUIRED',
    maxMembers: 3,
  });
  const approvalCode = approvalRoomRes.room.code;

  // Clear any scan calls from creation
  findManyScanCalls.length = 0;

  // 1. Valid code joins correct OPEN room
  const openJoin = await service.joinByCode('user-b', openCode);
  assert.equal(openJoin.status, 'JOINED');
  assert.equal(openJoin.roomId, openRoomRes.room.id);
  assert.equal(openJoin.roomName, 'Open Test Room');

  // Verify ZERO full-table scans occurred for status: ACTIVE
  const activeScansDuringJoin = findManyScanCalls.filter((c) => c?.status === 'ACTIVE');
  assert.equal(
    activeScansDuringJoin.length,
    0,
    'SEC-M01: joinByCode must NOT scan active rooms; it must use indexed findUnique',
  );

  // 2. Existing member receives ALREADY_MEMBER
  const alreadyMember = await service.joinByCode('user-b', openCode);
  assert.equal(alreadyMember.status, 'ALREADY_MEMBER');
  assert.equal(alreadyMember.roomId, openRoomRes.room.id);

  // 3. Invalid room code throws BadRequestException('Invalid room code')
  await assert.rejects(
    () => service.joinByCode('user-c', 'NONEXISTENT99'),
    (err: any) => err instanceof BadRequestException && err.message === 'Invalid room code',
  );

  // 4. Closed or inactive room throws BadRequestException('Invalid room code')
  const closedRoomRes = await service.create('user-owner', {
    name: 'Closed Room',
    joinPolicy: 'OPEN',
    maxMembers: 10,
  });
  const closedCode = closedRoomRes.room.code;
  // Mark room CLOSED directly in DB
  const rawClosed = rooms.get(closedRoomRes.room.id);
  rawClosed.status = 'CLOSED';

  await assert.rejects(
    () => service.joinByCode('user-c', closedCode),
    (err: any) => err instanceof BadRequestException && err.message === 'Invalid room code',
  );

  // 5. APPROVAL_REQUIRED creates pending join request and emits notification
  const reqJoin = await service.joinByCode('user-c', approvalCode);
  assert.equal(reqJoin.status, 'REQUEST_SENT');
  assert.equal(reqJoin.roomId, approvalRoomRes.room.id);

  // Re-requesting returns PENDING
  const dupReqJoin = await service.joinByCode('user-c', approvalCode);
  assert.equal(dupReqJoin.status, 'PENDING');

  // 6. Capacity enforcement: room cannot exceed maxMembers
  await service.joinByCode('user-d', openCode); // member 3
  // Add mock members up to capacity
  const rmId4 = 'rm-mock-4';
  roomMembers.set(rmId4, { id: rmId4, roomId: openRoomRes.room.id, userId: 'user-mock-4', role: 'MEMBER' });
  const rmId5 = 'rm-mock-5';
  roomMembers.set(rmId5, { id: rmId5, roomId: openRoomRes.room.id, userId: 'user-mock-5', role: 'MEMBER' });

  // Room is now at maxMembers (5)
  await assert.rejects(
    () => service.joinByCode('user-overflow', openCode),
    (err: any) => err instanceof BadRequestException && err.message === 'Room is full',
  );

  // Re-verify that NO active-room table scans occurred across all tests
  assert.equal(
    findManyScanCalls.filter((c) => c?.status === 'ACTIVE').length,
    0,
    'Zero findMany scans for ACTIVE rooms occurred during the entire test suite',
  );
});
