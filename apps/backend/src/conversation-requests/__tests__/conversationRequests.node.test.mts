import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationRequestsService } from '../../../dist/conversation-requests/conversation-requests.service.js';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';

function createMockHarness() {
  const users = new Map([
    ['user-a', { id: 'user-a', username: 'alice', displayName: 'Alice A', status: 'ACTIVE', settings: { usernameSearchEnabled: true } }],
    ['user-b', { id: 'user-b', username: 'bob', displayName: 'Bob B', status: 'ACTIVE', settings: { usernameSearchEnabled: true } }],
    ['user-private', { id: 'user-private', username: 'privateuser', displayName: 'Private P', status: 'ACTIVE', settings: { usernameSearchEnabled: false } }],
    ['user-blocked', { id: 'user-blocked', username: 'blockeduser', displayName: 'Blocked B', status: 'ACTIVE', settings: { usernameSearchEnabled: true } }],
  ]);

  const requests = new Map();
  const conversations = new Map();
  const events = [];

  const mockRegistry = {
    pushToUser: (userId, event, payload) => {
      events.push({ userId, event, payload });
      return true;
    },
  };

  const mockPrisma = {
    user: {
      findUnique: async ({ where }) => {
        if (where.username) {
          for (const u of users.values()) {
            if (u.username === where.username) return u;
          }
          return null;
        }
        return users.get(where.id) || null;
      },
    },
    conversation: {
      findUnique: async ({ where }) => {
        if (where.userAId_userBId) {
          const { userAId, userBId } = where.userAId_userBId;
          return conversations.get(userAId + ':' + userBId) || null;
        }
        return null;
      },
      create: async ({ data }) => {
        const id = 'conv-' + Math.random().toString(36).slice(2);
        const record = { id, ...data };
        conversations.set(data.userAId + ':' + data.userBId, record);
        return record;
      },
      update: async ({ where, data }) => {
        for (const [key, conv] of conversations.entries()) {
          if (conv.id === where.id) {
            let sessionEpoch = conv.sessionEpoch || 1;
            if (data.sessionEpoch && data.sessionEpoch.increment) {
              sessionEpoch += data.sessionEpoch.increment;
            }
            const updated = { ...conv, ...data, sessionEpoch };
            conversations.set(key, updated);
            return updated;
          }
        }
        throw new Error('Conv not found');
      },
    },
    conversationRequest: {
      create: async ({ data }) => {
        const id = 'req-' + Math.random().toString(36).slice(2);
        const record = { id, ...data, createdAt: new Date(), updatedAt: new Date() };
        requests.set(id, record);
        return record;
      },
      findUnique: async ({ where, include }) => {
        const req = requests.get(where.id);
        if (!req) return null;
        let res = { ...req };
        if (include && include.recipient) {
          res.recipient = users.get(req.recipientId);
        }
        if (include && include.sender) {
          res.sender = users.get(req.senderId);
        }
        return res;
      },
      findFirst: async ({ where }) => {
        for (const req of requests.values()) {
          if (where.senderId && req.senderId !== where.senderId) continue;
          if (where.recipientId && req.recipientId !== where.recipientId) continue;
          if (where.status && req.status !== where.status) continue;
          return req;
        }
        return null;
      },
      findMany: async ({ where, include }) => {
        let list = Array.from(requests.values());
        if (where.recipientId) list = list.filter((r) => r.recipientId === where.recipientId);
        if (where.senderId) list = list.filter((r) => r.senderId === where.senderId);
        if (where.status) list = list.filter((r) => r.status === where.status);
        return list.map((req) => {
          let res = { ...req };
          if (include && include.sender) res.sender = users.get(req.senderId);
          if (include && include.recipient) res.recipient = users.get(req.recipientId);
          return res;
        });
      },
      update: async ({ where, data }) => {
        const req = requests.get(where.id);
        if (!req) throw new Error('Request not found');
        const updated = { ...req, ...data, updatedAt: new Date() };
        requests.set(where.id, updated);
        return updated;
      },
    },
    $transaction: async (fn) => fn(mockPrisma),
  };

  // Pre-seed a blocked conversation between user-a and user-blocked
  conversations.set('user-a:user-blocked', {
    id: 'conv-blocked',
    userAId: 'user-a',
    userBId: 'user-blocked',
    status: 'BLOCKED_BY_A',
    sessionEpoch: 1,
  });

  const service = new ConversationRequestsService(mockPrisma as any, mockRegistry as any);
  return { service, users, requests, conversations, events };
}

test('ConversationRequests: Self-request is rejected', async () => {
  const { service } = createMockHarness();
  await assert.rejects(
    () => service.sendRequest('user-a', { targetUsername: 'alice' }),
    (err: any) => err instanceof BadRequestException && err.message.includes('yourself'),
  );
});

test('ConversationRequests: Non-existent user returns uniform NotFoundException', async () => {
  const { service } = createMockHarness();
  await assert.rejects(
    () => service.sendRequest('user-a', { targetUsername: 'ghostuser' }),
    (err: any) => err instanceof NotFoundException && err.message.includes('not found'),
  );
});

test('ConversationRequests: User with usernameSearchEnabled=false is undiscoverable', async () => {
  const { service } = createMockHarness();
  await assert.rejects(
    () => service.sendRequest('user-a', { targetUsername: 'privateuser' }),
    (err: any) => err instanceof NotFoundException && err.message.includes('not found'),
  );
});

test('ConversationRequests: Blocked target returns uniform NotFoundException', async () => {
  const { service } = createMockHarness();
  await assert.rejects(
    () => service.sendRequest('user-a', { targetUsername: 'blockeduser' }),
    (err: any) => err instanceof NotFoundException && err.message.includes('not found'),
  );
});

test('ConversationRequests: Successful request creation, duplicate prevention, and listing', async () => {
  const { service, events } = createMockHarness();

  // Send request from Alice to Bob
  const res = await service.sendRequest('user-a', { targetUsername: 'bob' });
  assert.equal(res.success, true);
  assert.equal(res.status, 'PENDING');
  assert.equal(res.targetUser.username, 'bob');

  // Verify real-time notification to Bob
  assert.equal(events.length, 1);
  assert.equal(events[0].userId, 'user-b');
  assert.equal(events[0].event, 'conversation:request_received');

  // Duplicate pending request must be rejected with 409 Conflict
  await assert.rejects(
    () => service.sendRequest('user-a', { targetUsername: 'bob' }),
    (err: any) => err instanceof ConflictException,
  );

  // List pending requests
  const pendingB = await service.listPending('user-b');
  assert.equal(pendingB.incoming.length, 1);
  assert.equal(pendingB.incoming[0].sender.username, 'alice');
  assert.equal(pendingB.outgoing.length, 0);

  const pendingA = await service.listPending('user-a');
  assert.equal(pendingA.incoming.length, 0);
  assert.equal(pendingA.outgoing.length, 1);
  assert.equal(pendingA.outgoing[0].recipient.username, 'bob');
});

test('ConversationRequests: Acceptance creates/reactivates conversation and increments epoch', async () => {
  const { service, events } = createMockHarness();

  const req = await service.sendRequest('user-a', { targetUsername: 'bob' });

  // Wrong user cannot accept
  await assert.rejects(
    () => service.acceptRequest('user-a', req.requestId),
    (err: any) => err instanceof ForbiddenException,
  );

  // Bob accepts Alice's request
  const accepted = await service.acceptRequest('user-b', req.requestId);
  assert.equal(accepted.success, true);
  assert.ok(accepted.conversationId);
  assert.equal(accepted.sessionEpoch, 1);

  // Check event emitted to Alice
  const acceptEvt = events.find((e) => e.event === 'conversation:request_accepted');
  assert.ok(acceptEvt);
  assert.equal(acceptEvt.userId, 'user-a');

  // Once accepted, request is no longer active
  await assert.rejects(
    () => service.acceptRequest('user-b', req.requestId),
    (err: any) => err instanceof BadRequestException,
  );
});

test('ConversationRequests: Rejection and Cancellation flows', async () => {
  const { service, events } = createMockHarness();

  // Test rejection
  const req1 = await service.sendRequest('user-a', { targetUsername: 'bob' });
  const rej = await service.rejectRequest('user-b', req1.requestId);
  assert.equal(rej.success, true);

  const rejEvt = events.find((e) => e.event === 'conversation:request_rejected');
  assert.ok(rejEvt);
  assert.equal(rejEvt.userId, 'user-a');

  // Test cancellation by sender
  const req2 = await service.sendRequest('user-a', { targetUsername: 'bob' });
  const cancel = await service.cancelRequest('user-a', req2.requestId);
  assert.equal(cancel.success, true);

  // Non-sender cannot cancel
  const req3 = await service.sendRequest('user-a', { targetUsername: 'bob' });
  await assert.rejects(
    () => service.cancelRequest('user-b', req3.requestId),
    (err: any) => err instanceof ForbiddenException,
  );
});
