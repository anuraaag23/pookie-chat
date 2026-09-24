import { idbGet, idbSet, idbDelete } from '../storage/localDb.ts';
import { checkLocalSecret, hashLocalSecret } from '../localauth/localSecret.ts';

let activeAppLockUserId: string | null = null;

export function setActiveAppLockUser(userId: string | null): void {
  activeAppLockUserId = userId;
}

export function getActiveAppLockUser(): string | null {
  return activeAppLockUserId;
}

export async function resolveUserId(explicitUserId?: string | null): Promise<string | null> {
  if (explicitUserId) return explicitUserId;
  if (activeAppLockUserId) return activeAppLockUserId;
  try {
    const session = await idbGet<{ userId: string }>('auth:session');
    if (session?.userId) {
      activeAppLockUserId = session.userId;
      return session.userId;
    }
  } catch {
    // IDB access fallback
  }
  return null;
}

export async function migrateLegacyKeysIfNeeded(userId: string): Promise<void> {
  try {
    const legacyEnabled = await idbGet<boolean>('appLock:enabled');
    if (legacyEnabled !== null && (await idbGet(`appLock:${userId}:enabled`)) === null) {
      const verifier = await idbGet<string>('appLock:verifier');
      const timeout = await idbGet<number>('appLock:timeoutSeconds');
      const isLocked = await idbGet<boolean>('appLock:isLocked');
      const lastActiveAt = await idbGet<number>('appLock:lastActiveAt');

      await idbSet(`appLock:${userId}:enabled`, legacyEnabled);
      if (verifier) await idbSet(`appLock:${userId}:verifier`, verifier);
      if (typeof timeout === 'number') await idbSet(`appLock:${userId}:timeoutSeconds`, timeout);
      if (typeof isLocked === 'boolean') await idbSet(`appLock:${userId}:isLocked`, isLocked);
      if (typeof lastActiveAt === 'number') await idbSet(`appLock:${userId}:lastActiveAt`, lastActiveAt);

      await idbDelete('appLock:enabled');
      await idbDelete('appLock:verifier');
      await idbDelete('appLock:timeoutSeconds');
      await idbDelete('appLock:isLocked');
      await idbDelete('appLock:lastActiveAt');
    }
  } catch {
    // Migration best effort
  }
}

export async function isAppLockEnabled(userId?: string | null): Promise<boolean> {
  const uid = await resolveUserId(userId);
  if (!uid) return false;
  await migrateLegacyKeysIfNeeded(uid);
  const enabled = (await idbGet<boolean>(`appLock:${uid}:enabled`)) ?? false;
  const verifier = await idbGet<string>(`appLock:${uid}:verifier`);
  return enabled && !!verifier;
}

export async function setAppLockEnabled(enabled: boolean, userId?: string | null): Promise<void> {
  const uid = await resolveUserId(userId);
  if (!uid) return;
  await idbSet(`appLock:${uid}:enabled`, enabled);
  if (!enabled) {
    await idbSet(`appLock:${uid}:isLocked`, false);
  }
}

export async function isAppLocked(userId?: string | null): Promise<boolean> {
  const uid = await resolveUserId(userId);
  if (!uid) return false;
  return (await idbGet<boolean>(`appLock:${uid}:isLocked`)) ?? false;
}

export async function setAppLocked(locked: boolean, userId?: string | null): Promise<void> {
  const uid = await resolveUserId(userId);
  if (!uid) return;
  await idbSet(`appLock:${uid}:isLocked`, locked);
}

export async function getAppLockTimeoutSeconds(userId?: string | null): Promise<number> {
  const uid = await resolveUserId(userId);
  if (!uid) return 60;
  const timeout = await idbGet<number>(`appLock:${uid}:timeoutSeconds`);
  return typeof timeout === 'number' ? timeout : 60;
}

export async function setAppLockTimeoutSeconds(seconds: number, userId?: string | null): Promise<void> {
  const uid = await resolveUserId(userId);
  if (!uid) return;
  await idbSet(`appLock:${uid}:timeoutSeconds`, seconds);
}

export async function getAppLockVerifier(userId?: string | null): Promise<string | null> {
  const uid = await resolveUserId(userId);
  if (!uid) return null;
  return idbGet<string>(`appLock:${uid}:verifier`);
}

export async function setAppLockVerifier(verifier: string, userId?: string | null): Promise<void> {
  const uid = await resolveUserId(userId);
  if (!uid) return;
  await idbSet(`appLock:${uid}:verifier`, verifier);
}

export async function hasAppLockVerifier(userId?: string | null): Promise<boolean> {
  const verifier = await getAppLockVerifier(userId);
  return verifier !== null && verifier.length > 0;
}

export async function verifyAppLockPin(pin: string, userId?: string | null): Promise<boolean> {
  const uid = await resolveUserId(userId);
  if (!uid) return false;
  const verifier = await getAppLockVerifier(uid);
  return checkLocalSecret(pin, verifier);
}

export async function changeAppLockPin(
  currentPin: string,
  newPin: string,
  userId?: string | null,
): Promise<{ success: boolean; error?: string }> {
  const uid = await resolveUserId(userId);
  if (!uid) return { success: false, error: 'User session not found.' };

  const validCurrent = await verifyAppLockPin(currentPin, uid);
  if (!validCurrent) {
    return { success: false, error: 'Current PIN is incorrect.' };
  }

  if (!newPin || newPin.length < 4) {
    return { success: false, error: 'New PIN must be at least 4 digits.' };
  }

  if (currentPin === newPin) {
    return { success: false, error: 'New PIN must be different from current PIN.' };
  }

  const newVerifier = await hashLocalSecret(newPin);
  await setAppLockVerifier(newVerifier, uid);
  await recordActivity(uid);
  return { success: true };
}

export async function disableAppLockWithPin(
  currentPin: string,
  userId?: string | null,
): Promise<{ success: boolean; error?: string }> {
  const uid = await resolveUserId(userId);
  if (!uid) return { success: false, error: 'User session not found.' };

  const validCurrent = await verifyAppLockPin(currentPin, uid);
  if (!validCurrent) {
    return { success: false, error: 'Current PIN is incorrect.' };
  }

  await setAppLockEnabled(false, uid);
  await setAppLocked(false, uid);
  return { success: true };
}

export async function getLastActiveAt(userId?: string | null): Promise<number> {
  const uid = await resolveUserId(userId);
  if (!uid) return 0;
  return (await idbGet<number>(`appLock:${uid}:lastActiveAt`)) ?? 0;
}

export async function recordActivity(userId?: string | null, now = Date.now()): Promise<void> {
  const uid = await resolveUserId(userId);
  if (!uid) return;
  await idbSet(`appLock:${uid}:lastActiveAt`, now);
}

export async function clearUserAppLock(userId: string): Promise<void> {
  await idbDelete(`appLock:${userId}:enabled`);
  await idbDelete(`appLock:${userId}:verifier`);
  await idbDelete(`appLock:${userId}:timeoutSeconds`);
  await idbDelete(`appLock:${userId}:isLocked`);
  await idbDelete(`appLock:${userId}:lastActiveAt`);
}

/**
 * Evaluates whether the application should display the lock screen.
 */
export async function shouldBeLocked(
  isContextBoundary = false,
  now = Date.now(),
  userId?: string | null,
  gracePeriodMs = 1500,
): Promise<boolean> {
  const uid = await resolveUserId(userId);
  if (!uid || !(await isAppLockEnabled(uid))) return false;
  if (await isAppLocked(uid)) return true;

  const timeoutSeconds = await getAppLockTimeoutSeconds(uid);
  const lastActiveAt = await getLastActiveAt(uid);

  if (timeoutSeconds === 0) {
    if (isContextBoundary) {
      const elapsed = now - lastActiveAt;
      if (elapsed >= gracePeriodMs) {
        await setAppLocked(true, uid);
        return true;
      }
    }
    return false;
  }

  const elapsed = now - lastActiveAt;
  if (elapsed >= timeoutSeconds * 1000) {
    await setAppLocked(true, uid);
    return true;
  }
  return false;
}


