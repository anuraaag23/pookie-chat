import { idbGet, idbSet } from '../storage/localDb.ts';
import { api } from '../api/client.ts';

/**
 * In-memory session cache of currently unlocked conversation IDs.
 * Persists only for the active tab session. Reloading or restarting
 * requires the user to re-authenticate with their account password.
 */
const sessionUnlockedChats = new Set<string>();

function getHiddenKey(userId?: string | null): string {
  return userId ? `hiddenChats:${userId}` : 'hiddenChats:default';
}

function getLockedKey(userId?: string | null): string {
  return userId ? `chatLock:${userId}:lockedList` : 'chatLock:default:lockedList';
}

export async function getHiddenChatIds(userId?: string | null): Promise<string[]> {
  const list = await idbGet<string[]>(getHiddenKey(userId));
  return Array.isArray(list) ? list : [];
}

export async function hideChat(conversationId: string, userId?: string | null): Promise<void> {
  const current = await getHiddenChatIds(userId);
  if (!current.includes(conversationId)) {
    const updated = [...current, conversationId];
    await idbSet(getHiddenKey(userId), updated);
  }
}

export async function unhideChat(conversationId: string, userId?: string | null): Promise<void> {
  const current = await getHiddenChatIds(userId);
  const updated = current.filter((id) => id !== conversationId);
  await idbSet(getHiddenKey(userId), updated);
}

export async function isChatHidden(conversationId: string, userId?: string | null): Promise<boolean> {
  const current = await getHiddenChatIds(userId);
  return current.includes(conversationId);
}

export async function getLockedChatIds(userId?: string | null): Promise<string[]> {
  const list = await idbGet<string[]>(getLockedKey(userId));
  return Array.isArray(list) ? list : [];
}

export async function lockChat(conversationId: string, userId?: string | null): Promise<void> {
  const current = await getLockedChatIds(userId);
  if (!current.includes(conversationId)) {
    const updated = [...current, conversationId];
    await idbSet(getLockedKey(userId), updated);
  }
  // Once locked, remove from active session unlocked set so auth is required immediately
  sessionUnlockedChats.delete(conversationId);
}

export async function unlockChatPermanently(conversationId: string, userId?: string | null): Promise<void> {
  const current = await getLockedChatIds(userId);
  const updated = current.filter((id) => id !== conversationId);
  await idbSet(getLockedKey(userId), updated);
  sessionUnlockedChats.delete(conversationId);
}

export async function isChatLocked(conversationId: string, userId?: string | null): Promise<boolean> {
  const current = await getLockedChatIds(userId);
  return current.includes(conversationId);
}

export function isChatSessionUnlocked(conversationId: string): boolean {
  return sessionUnlockedChats.has(conversationId);
}

export function setChatSessionUnlocked(conversationId: string, unlocked = true): void {
  if (unlocked) {
    sessionUnlockedChats.add(conversationId);
  } else {
    sessionUnlockedChats.delete(conversationId);
  }
}

export function clearAllSessionUnlocked(): void {
  sessionUnlockedChats.clear();
}

/**
 * Re-authenticates the current user using their account password.
 * Uses the server-side verify-password endpoint with constant-time Scrypt verification
 * and brute-force rate-limiting.
 */
export async function verifyAccountPassword(password: string): Promise<boolean> {
  try {
    const res = await api<{ valid: boolean }>('/api/auth/verify-password', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
    return !!res.valid;
  } catch {
    return false;
  }
}
