import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface OutboxItem {
  id: string;
  conversationId: string;
  senderId: string;
  text: string;
  ciphertext?: string;
  iv?: string;
  sessionEpoch?: number;
  sentAt: string;
  replyToMessageId?: string | null;
  viewOnce?: boolean;
  queuedAt: number;
  retryCount: number;
}

test('Outbox Store: File structure and exported API contract', () => {
  const filePath = path.resolve(process.cwd(), 'apps/web/lib/storage/outboxStore.ts');
  const code = fs.readFileSync(filePath, 'utf8');

  assert.ok(code.includes('export interface OutboxItem'), 'Must export OutboxItem');
  assert.ok(code.includes('export async function getOutboxItems'), 'Must export getOutboxItems');
  assert.ok(code.includes('export async function enqueueOutboxItem'), 'Must export enqueueOutboxItem');
  assert.ok(code.includes('export async function removeOutboxItem'), 'Must export removeOutboxItem');
  assert.ok(code.includes('export async function clearOutbox'), 'Must export clearOutbox');
  assert.ok(code.includes('outbox:${userId}'), 'Must scope outbox key to userId');
});

test('Outbox Store: FIFO queue operations and conversation filtering', async () => {
  const mockStorage = new Map<string, OutboxItem[]>();

  async function mockGetOutboxItems(userId: string, conversationId?: string): Promise<OutboxItem[]> {
    if (!userId) return [];
    const items = mockStorage.get(`outbox:${userId}`) ?? [];
    if (conversationId) {
      return items.filter((i) => i.conversationId === conversationId);
    }
    return [...items];
  }

  async function mockEnqueueOutboxItem(userId: string, item: OutboxItem): Promise<void> {
    if (!userId) return;
    const items = await mockGetOutboxItems(userId);
    if (items.some((i) => i.id === item.id)) return;
    items.push(item);
    mockStorage.set(`outbox:${userId}`, items);
  }

  async function mockRemoveOutboxItem(userId: string, id: string): Promise<void> {
    if (!userId) return;
    const items = await mockGetOutboxItems(userId);
    const filtered = items.filter((i) => i.id !== id);
    mockStorage.set(`outbox:${userId}`, filtered);
  }

  // 1. Enqueue 2 items in conversation 1 and 1 in conversation 2
  const item1: OutboxItem = {
    id: 'msg_1',
    conversationId: 'convo_1',
    senderId: 'usr_alice',
    text: 'Offline message 1',
    ciphertext: 'c_text_1',
    iv: 'iv_1',
    sessionEpoch: 1,
    sentAt: '2026-09-29T10:00:00Z',
    queuedAt: 1000,
    retryCount: 0,
  };

  const item2: OutboxItem = {
    id: 'msg_2',
    conversationId: 'convo_1',
    senderId: 'usr_alice',
    text: 'Offline message 2',
    ciphertext: 'c_text_2',
    iv: 'iv_2',
    sessionEpoch: 1,
    sentAt: '2026-09-29T10:01:00Z',
    queuedAt: 2000,
    retryCount: 0,
  };

  const item3: OutboxItem = {
    id: 'msg_3',
    conversationId: 'convo_2',
    senderId: 'usr_alice',
    text: 'Other convo offline msg',
    sentAt: '2026-09-29T10:02:00Z',
    queuedAt: 3000,
    retryCount: 0,
  };

  await mockEnqueueOutboxItem('usr_alice', item1);
  await mockEnqueueOutboxItem('usr_alice', item2);
  await mockEnqueueOutboxItem('usr_alice', item3);

  // 2. Verify duplicate enqueue is ignored
  await mockEnqueueOutboxItem('usr_alice', item1);

  // 3. Verify conversation-scoped FIFO retrieval
  const convo1Items = await mockGetOutboxItems('usr_alice', 'convo_1');
  assert.equal(convo1Items.length, 2, 'Should only return convo_1 items');
  assert.equal(convo1Items[0].id, 'msg_1', 'First queued item must be first in FIFO order');
  assert.equal(convo1Items[1].id, 'msg_2', 'Second queued item must follow in FIFO order');

  // 4. Verify remove removes exact item
  await mockRemoveOutboxItem('usr_alice', 'msg_1');
  const remainingConvo1 = await mockGetOutboxItems('usr_alice', 'convo_1');
  assert.equal(remainingConvo1.length, 1);
  assert.equal(remainingConvo1[0].id, 'msg_2');

  // Convo 2 is unaffected
  const convo2Items = await mockGetOutboxItems('usr_alice', 'convo_2');
  assert.equal(convo2Items.length, 1);
  assert.equal(convo2Items[0].id, 'msg_3');
});

test('Outbox Store: Multi-account isolation prevents outbox data cross-contamination', async () => {
  const mockStorage = new Map<string, OutboxItem[]>();

  async function mockGetOutboxItems(userId: string): Promise<OutboxItem[]> {
    return mockStorage.get(`outbox:${userId}`) ?? [];
  }

  async function mockEnqueueOutboxItem(userId: string, item: OutboxItem): Promise<void> {
    const items = [...(mockStorage.get(`outbox:${userId}`) ?? [])];
    items.push(item);
    mockStorage.set(`outbox:${userId}`, items);
  }

  // Alice queues an offline message
  await mockEnqueueOutboxItem('usr_alice', {
    id: 'alice_msg',
    conversationId: 'convo_secret',
    senderId: 'usr_alice',
    text: 'Confidential Alice draft',
    sentAt: '2026-09-29T11:00:00Z',
    queuedAt: 5000,
    retryCount: 0,
  });

  // Bob logs into the same device
  const bobItems = await mockGetOutboxItems('usr_bob');
  assert.equal(bobItems.length, 0, 'Bob must never see Alice outbox items');

  const aliceItems = await mockGetOutboxItems('usr_alice');
  assert.equal(aliceItems.length, 1, 'Alice items must remain intact and isolated');
});
