import { idbGet, idbSet, idbDelete } from '../storage/localDb';
import type { SessionKeys } from './engine';

export { isSessionStale } from './sessionFreshness';

export interface StoredSession {
  sendingChainKey: Uint8Array;
  receivingChainKey: Uint8Array;
  sendStep: number;
  recvStep: number;
  // Highest server sequenceNumber this device has already synced from the
  // other party. Drives /api/messages/sync's `after` param so a refresh or
  // reconnect only ever fetches (and decrypts) genuinely new messages —
  // never re-requests what's already been processed.
  lastSyncedSeq: number;
  // The conversation's sessionEpoch (Conversation.sessionEpoch,
  // apps/backend/src/domain/sessionEpoch.ts) at the moment this exact
  // session was established — i.e. which X3DH handshake this ratchet
  // state actually came from. conversationId alone cannot answer that:
  // re-pairing after a burn reuses the same conversationId, so a device
  // that was offline for an entire burn+re-pair cycle would otherwise
  // have no way to notice its cached session is from a pairing that no
  // longer exists. See isSessionStale below.
  epoch: number;
}

function key(conversationId: string): string {
  return `session:${conversationId}`;
}

export async function loadSession(conversationId: string): Promise<StoredSession | null> {
  return idbGet<StoredSession>(key(conversationId));
}

export async function saveSession(conversationId: string, session: StoredSession): Promise<void> {
  await idbSet(key(conversationId), session);
}

export async function initSession(conversationId: string, keys: SessionKeys, epoch: number): Promise<StoredSession> {
  const session: StoredSession = { ...keys, sendStep: 0, recvStep: 0, lastSyncedSeq: 0, epoch };
  await saveSession(conversationId, session);
  return session;
}

/** Used by "Burn Conversation" — once this is gone, decrypting anything from this conversation again requires re-pairing, exactly like losing the device (docs/03-ENCRYPTION-PROTOCOL.md §11). */
export async function deleteSession(conversationId: string): Promise<void> {
  await idbDelete(key(conversationId));
}
