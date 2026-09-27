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
  const userList = Array.isArray(list) ? list : [];
  if (userId) {
    const defaultList = await idbGet<string[]>('chatLock:default:lockedList');
    if (Array.isArray(defaultList) && defaultList.length > 0) {
      const merged = Array.from(new Set([...userList, ...defaultList]));
      await idbSet(getLockedKey(userId), merged);
      return merged;
    }
  }
  return userList;
}

export async function lockChat(conversationId: string, userId?: string | null): Promise<void> {
  const current = await getLockedChatIds(userId);
  if (!current.includes(conversationId)) {
    const updated = [...current, conversationId];
    await idbSet(getLockedKey(userId), updated);
  }
  // Once locked, remove from active session unlocked set so auth is required immediately
  setChatSessionUnlocked(conversationId, false);
}

export async function unlockChatPermanently(conversationId: string, userId?: string | null): Promise<void> {
  const current = await getLockedChatIds(userId);
  const updated = current.filter((id) => id !== conversationId);
  await idbSet(getLockedKey(userId), updated);
  if (userId) {
    const defaultList = await idbGet<string[]>('chatLock:default:lockedList');
    if (Array.isArray(defaultList) && defaultList.includes(conversationId)) {
      await idbSet('chatLock:default:lockedList', defaultList.filter((id) => id !== conversationId));
    }
  }
  setChatSessionUnlocked(conversationId, false);
}

export async function isChatLocked(conversationId: string, userId?: string | null): Promise<boolean> {
  const current = await getLockedChatIds(userId);
  return current.includes(conversationId);
}

export function isChatSessionUnlocked(conversationId: string): boolean {
  if (sessionUnlockedChats.has(conversationId)) return true;
  if (typeof window !== 'undefined' && window.sessionStorage) {
    return window.sessionStorage.getItem(`chatLock:unlocked:${conversationId}`) === 'true';
  }
  return false;
}

export function setChatSessionUnlocked(conversationId: string, unlocked = true): void {
  if (unlocked) {
    sessionUnlockedChats.add(conversationId);
    if (typeof window !== 'undefined' && window.sessionStorage) {
      try {
        window.sessionStorage.setItem(`chatLock:unlocked:${conversationId}`, 'true');
      } catch {}
    }
  } else {
    sessionUnlockedChats.delete(conversationId);
    if (typeof window !== 'undefined' && window.sessionStorage) {
      try {
        window.sessionStorage.removeItem(`chatLock:unlocked:${conversationId}`);
      } catch {}
    }
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('chat-lock-state-changed', {
        detail: { conversationId, unlocked },
      }),
    );
  }
}

export function clearAllSessionUnlocked(): void {
  sessionUnlockedChats.clear();
  if (typeof window !== 'undefined' && window.sessionStorage) {
    try {
      const keys = Object.keys(window.sessionStorage);
      for (const k of keys) {
        if (k.startsWith('chatLock:unlocked:')) {
          window.sessionStorage.removeItem(k);
        }
      }
    } catch {}
  }
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

export type FeaturePasswordType = 'burn' | 'lock' | 'hide';

/**
 * Verify a dedicated feature password (burn, lock, hide) using the secure server endpoint.
 */
export async function verifyFeaturePassword(feature: FeaturePasswordType, password: string): Promise<boolean> {
  try {
    const res = await api<{ valid: boolean }>('/api/settings/feature-passwords/verify', {
      method: 'POST',
      body: { feature, password },
    });
    return !!res.valid;
  } catch {
    return false;
  }
}

/**
 * Configure or update a dedicated feature password (burn, lock, hide).
 */
export async function setFeaturePassword(
  feature: FeaturePasswordType,
  newPassword: string,
  currentPassword?: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await api<{ success: boolean }>('/api/settings/feature-passwords/set', {
      method: 'POST',
      body: { feature, newPassword, currentPassword },
    });
    return { success: !!res.success };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Failed to set password' };
  }
}

