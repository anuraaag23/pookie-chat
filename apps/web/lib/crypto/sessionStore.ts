import { idbGet, idbSet, idbDelete } from '../storage/localDb';
import { resolveCryptoUserId } from '../storage/userScope';
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

export async function loadSession(conversationId: string, explicitUserId?: string | null): Promise<StoredSession | null> {
  const uid = await resolveCryptoUserId(explicitUserId);
  if (!uid) return null;
  const primaryKey = `crypto:ratchet:${uid}:${conversationId}`;
  let session = await idbGet<StoredSession>(primaryKey);
  if (!session) {
    const intermediate = await idbGet<StoredSession>(`session:${uid}:${conversationId}`);
    if (intermediate) {
      await idbSet(primaryKey, intermediate);
      await idbDelete(`session:${uid}:${conversationId}`);
      session = intermediate;
    } else {
      const legacy = await idbGet<StoredSession>(`session:${conversationId}`);
      if (legacy) {
        await idbSet(primaryKey, legacy);
        await idbDelete(`session:${conversationId}`);
        session = legacy;
      }
    }
  }
  return session;
}

export async function saveSession(conversationId: string, session: StoredSession, explicitUserId?: string | null): Promise<void> {
  const uid = await resolveCryptoUserId(explicitUserId);
  if (!uid) return;
  await idbSet(`crypto:ratchet:${uid}:${conversationId}`, session);
}

export async function initSession(conversationId: string, keys: SessionKeys, epoch: number, explicitUserId?: string | null): Promise<StoredSession> {
  const session: StoredSession = { ...keys, sendStep: 0, recvStep: 0, lastSyncedSeq: 0, epoch };
  await saveSession(conversationId, session, explicitUserId);
  return session;
}

/** Used by "Burn Conversation" — once this is gone, decrypting anything from this conversation again requires re-pairing, exactly like losing the device (docs/03-ENCRYPTION-PROTOCOL.md §11). */
export async function deleteSession(conversationId: string, explicitUserId?: string | null): Promise<void> {
  const uid = await resolveCryptoUserId(explicitUserId);
  if (uid) {
    await idbDelete(`crypto:ratchet:${uid}:${conversationId}`);
    await idbDelete(`session:${uid}:${conversationId}`);
  }
  await idbDelete(`session:${conversationId}`);
}
