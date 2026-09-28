import { idbGet, idbSet, idbDelete } from './localDb';

let activeCryptoUserId: string | null = null;

export function setActiveCryptoUser(userId: string | null): void {
  activeCryptoUserId = userId;
}

export function getActiveCryptoUser(): string | null {
  return activeCryptoUserId;
}

export async function resolveCryptoUserId(explicitUserId?: string | null): Promise<string | null> {
  if (explicitUserId) return explicitUserId;
  if (activeCryptoUserId) return activeCryptoUserId;
  try {
    const session = await idbGet<{ userId: string }>('auth:session');
    if (session?.userId) {
      activeCryptoUserId = session.userId;
      return session.userId;
    }
  } catch {
    // IDB access fallback
  }
  return null;
}

function normalizeLookupKey(identifier: string): string {
  return identifier.trim().toLowerCase();
}

/**
 * Stores a lookup mapping from an identifier (username or email) to a userId
 * so returning logins for Account A on this device can find their existing device identity.
 */
export async function storeUserIdentityLookup(identifier: string, userId: string): Promise<void> {
  if (!identifier || !userId) return;
  const normalized = normalizeLookupKey(identifier);
  await idbSet(`crypto:identity:lookup:${normalized}`, userId);
}

/**
 * Resolves a previously recorded userId for this identifier on this device.
 */
export async function lookupUserForIdentifier(identifier: string): Promise<string | null> {
  if (!identifier) return null;
  const normalized = normalizeLookupKey(identifier);
  return (await idbGet<string>(`crypto:identity:lookup:${normalized}`)) ?? null;
}

/**
 * Loads the authenticated user's device identity, strictly isolating accounts
 * on shared devices while preserving identity for returning logins.
 */
export async function getUserIdentity(explicitUserId?: string | null): Promise<any | null> {
  const uid = await resolveCryptoUserId(explicitUserId);
  if (!uid) return null;
  const userScoped = await idbGet(`crypto:identity:${uid}`);
  if (userScoped) return userScoped;

  // Safe one-time legacy migration only if active session matches this user
  const session = await idbGet<{ userId: string }>('auth:session');
  if (session?.userId === uid) {
    const legacy = await idbGet<any>('crypto:identity');
    if (legacy) {
      await idbSet(`crypto:identity:${uid}`, legacy);
      await idbDelete('crypto:identity');
      return legacy;
    }
  }
  return null;
}

