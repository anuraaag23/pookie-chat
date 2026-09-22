import { idbGet, idbSet } from '../storage/localDb';

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
  status: 'sent' | 'delivered' | 'read' | 'failed';
  mine: boolean;
}

/**
 * Decrypted content, cached locally so the chat screen doesn't lose your
 * own sent-message history on refresh (the sync endpoint only ever
 * returns the *other* party's messages — see messages.service.ts's fix —
 * so it was never going to restore your own side of the conversation).
 *
 * This is plaintext at rest in IndexedDB. That is not a new exposure
 * specific to this cache: the whole point of E2EE is that decrypted
 * content exists on-device, and anything reading the DOM or the app's
 * own memory already sees it. App lock (lib/applock) is what actually
 * gates access to this device; this file doesn't re-encrypt on top of
 * that, consistent with docs/03-ENCRYPTION-PROTOCOL.md §14's browser
 * key-storage trade-offs.
 */

function key(conversationId: string): string {
  return `messageCache:${conversationId}`;
}

export async function getCachedMessages(conversationId: string): Promise<CachedMessage[]> {
  return (await idbGet<CachedMessage[]>(key(conversationId))) ?? [];
}

export async function appendCachedMessage(msg: CachedMessage): Promise<void> {
  const existing = await getCachedMessages(msg.conversationId);
  if (existing.some((m) => m.id === msg.id)) return; // idempotent — a retried sync shouldn't duplicate
  existing.push(msg);
  await idbSet(key(msg.conversationId), existing);
}

export async function updateCachedMessage(
  conversationId: string,
  id: string,
  patch: Partial<Omit<CachedMessage, 'id' | 'conversationId'>>,
): Promise<void> {
  const existing = await getCachedMessages(conversationId);
  const next = existing.map((m) => (m.id === id ? { ...m, ...patch } : m));
  await idbSet(key(conversationId), next);
}

export async function removeCachedMessage(conversationId: string, id: string): Promise<void> {
  const existing = await getCachedMessages(conversationId);
  await idbSet(key(conversationId), existing.filter((m) => m.id !== id));
}

/** Used by "Burn Conversation" — wipes this device's decrypted copy, same act as deleting the ratchet session. */
export async function clearCachedMessages(conversationId: string): Promise<void> {
  await idbSet(key(conversationId), []);
}

export interface SearchResult extends CachedMessage {
  snippet: string;
}

/**
 * Local, client-side search across every conversation's cached plaintext
 * — the server never sees the query or the content, since it never has
 * the content at all (docs/00-ARCHITECTURE.md, §19 SEARCH). Needs the
 * list of conversation IDs to search, since IndexedDB has no native
 * cross-key "LIKE" query — this is a straightforward substring scan,
 * fine at the message volumes a 1:1-only app accumulates.
 */
export async function searchLocalMessages(conversationIds: string[], query: string): Promise<SearchResult[]> {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const results: SearchResult[] = [];
  for (const conversationId of conversationIds) {
    const messages = await getCachedMessages(conversationId);
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
