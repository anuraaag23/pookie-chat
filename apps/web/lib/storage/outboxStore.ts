import { idbGet, idbSet } from './localDb.ts';

export interface OutboxItem {
  id: string; // clientMessageId
  conversationId: string;
  senderId: string;
  text: string; // plaintext
  ciphertext?: string;
  iv?: string;
  sessionEpoch?: number;
  sentAt: string;
  replyToMessageId?: string | null;
  viewOnce?: boolean;
  queuedAt: number;
  retryCount: number;
}

function getOutboxKey(userId: string): string {
  return `outbox:${userId}`;
}

export async function getOutboxItems(userId: string, conversationId?: string): Promise<OutboxItem[]> {
  if (!userId) return [];
  const items = (await idbGet<OutboxItem[]>(getOutboxKey(userId))) ?? [];
  if (conversationId) {
    return items.filter((i) => i.conversationId === conversationId);
  }
  return items;
}

export async function enqueueOutboxItem(userId: string, item: OutboxItem): Promise<void> {
  if (!userId) return;
  const items = await getOutboxItems(userId);
  // Prevent duplicate enqueue
  if (items.some((i) => i.id === item.id)) return;
  items.push(item);
  await idbSet(getOutboxKey(userId), items);
}

export async function removeOutboxItem(userId: string, id: string): Promise<void> {
  if (!userId) return;
  const items = await getOutboxItems(userId);
  const filtered = items.filter((i) => i.id !== id);
  await idbSet(getOutboxKey(userId), filtered);
}

export async function clearOutbox(userId: string): Promise<void> {
  if (!userId) return;
  await idbSet(getOutboxKey(userId), []);
}
