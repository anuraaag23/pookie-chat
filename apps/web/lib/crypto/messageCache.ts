import { idbGet, idbSet, idbDelete } from '../storage/localDb';
import { resolveCryptoUserId } from '../storage/userScope';

export interface CachedMessage {
  id: string;
  conversationId: string;
  senderId: string;
  text: string;
  sentAt: string;
  // 'failed' covers an optimistically-cached message whose send attempt
  // errored (see app/chat/[conversationId]/page.tsx's catch block) —
  // MessageBubble has always rendered this status correctly; this type
  // just hadn't caught up, which was enough to fail `next build`'s
  // type-check outright.
  status: 'sent' | 'delivered' | 'read' | 'failed' | 'queued';
  mine: boolean;
  replyToMessageId?: string | null;
  replyTo?: {
    messageId?: string;
    senderUsername?: string;
    text: string;
  } | null;
}

/**
 * Decrypted content, cached locally so the chat screen doesn't lose your
 * own sent-message history on refresh. Plaintext at rest in IndexedDB is scoped
 * per authenticated user (`messages:<userId>:<conversationId>`), ensuring multiple
 * users on the same device never leak or inherit each other's message history.
 */

export async function getCachedMessages(conversationId: string, explicitUserId?: string | null): Promise<CachedMessage[]> {
  const uid = await resolveCryptoUserId(explicitUserId);
  if (!uid) return [];
  const primaryKey = `messages:${uid}:${conversationId}`;
  let messages = await idbGet<CachedMessage[]>(primaryKey);
  if (!messages) {
    const intermediate = await idbGet<CachedMessage[]>(`messageCache:${uid}:${conversationId}`);
    if (intermediate) {
      await idbSet(primaryKey, intermediate);
      await idbDelete(`messageCache:${uid}:${conversationId}`);
      messages = intermediate;
    } else {
      const legacy = await idbGet<CachedMessage[]>(`messageCache:${conversationId}`);
      if (legacy) {
        await idbSet(primaryKey, legacy);
        await idbDelete(`messageCache:${conversationId}`);
        messages = legacy;
      }
    }
  }
  return messages ?? [];
}

export async function appendCachedMessage(msg: CachedMessage, explicitUserId?: string | null): Promise<void> {
  const uid = await resolveCryptoUserId(explicitUserId ?? (msg.mine ? msg.senderId : undefined));
  if (!uid) return;
  const existing = await getCachedMessages(msg.conversationId, uid);
  if (existing.some((m) => m.id === msg.id)) return; // idempotent — a retried sync shouldn't duplicate
  existing.push(msg);
  await idbSet(`messages:${uid}:${msg.conversationId}`, existing);
}

export async function updateCachedMessage(
  conversationId: string,
  id: string,
  patch: Partial<Omit<CachedMessage, 'id' | 'conversationId'>>,
  explicitUserId?: string | null,
): Promise<void> {
  const uid = await resolveCryptoUserId(explicitUserId);
  if (!uid) return;
  const existing = await getCachedMessages(conversationId, uid);
  const next = existing.map((m) => (m.id === id ? { ...m, ...patch } : m));
  await idbSet(`messages:${uid}:${conversationId}`, next);
}

export async function removeCachedMessage(conversationId: string, id: string, explicitUserId?: string | null): Promise<void> {
  const uid = await resolveCryptoUserId(explicitUserId);
  if (!uid) return;
  const existing = await getCachedMessages(conversationId, uid);
  await idbSet(`messages:${uid}:${conversationId}`, existing.filter((m) => m.id !== id));
}

/** Used by "Burn Conversation" — wipes this device's decrypted copy, same act as deleting the ratchet session. */
export async function clearCachedMessages(conversationId: string, explicitUserId?: string | null): Promise<void> {
  const uid = await resolveCryptoUserId(explicitUserId);
  if (uid) {
    await idbSet(`messages:${uid}:${conversationId}`, []);
    await idbDelete(`messageCache:${uid}:${conversationId}`);
  }
  await idbDelete(`messageCache:${conversationId}`);
}

export interface SearchResult extends CachedMessage {
  snippet: string;
}

/**
 * Local, client-side search across every conversation's cached plaintext
 * — scoped to the active user's cached messages.
 */
export async function searchLocalMessages(conversationIds: string[], query: string, explicitUserId?: string | null): Promise<SearchResult[]> {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const uid = await resolveCryptoUserId(explicitUserId);
  if (!uid) return [];
  const results: SearchResult[] = [];
  for (const conversationId of conversationIds) {
    const messages = await getCachedMessages(conversationId, uid);
    for (const m of messages) {
      const idx = m.text.toLowerCase().indexOf(q);
      if (idx === -1) continue;
      const start = Math.max(0, idx - 20);
      const snippet = (start > 0 ? '…' : '') + m.text.slice(start, idx + q.length + 20);
      results.push({ ...m, snippet });
    }
  }
  return results.sort((a, b) => (a.sentAt < b.sentAt ? 1 : -1));
}
