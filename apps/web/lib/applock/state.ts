import { idbGet, idbSet } from '../storage/localDb';

export async function isAppLockEnabled(): Promise<boolean> {
  return (await idbGet<boolean>('appLock:enabled')) ?? false;
}

export async function setAppLockEnabled(enabled: boolean): Promise<void> {
  await idbSet('appLock:enabled', enabled);
  if (!enabled) {
    await idbSet('appLock:isLocked', false);
  }
}

export async function isAppLocked(): Promise<boolean> {
  return (await idbGet<boolean>('appLock:isLocked')) ?? false;
}

export async function setAppLocked(locked: boolean): Promise<void> {
  await idbSet('appLock:isLocked', locked);
}

export async function getAppLockTimeoutSeconds(): Promise<number> {
  const timeout = await idbGet<number>('appLock:timeoutSeconds');
  return typeof timeout === 'number' ? timeout : 60;
}

export async function setAppLockTimeoutSeconds(seconds: number): Promise<void> {
  await idbSet('appLock:timeoutSeconds', seconds);
}

export async function getLastActiveAt(): Promise<number> {
  return (await idbGet<number>('appLock:lastActiveAt')) ?? 0;
}

export async function recordActivity(): Promise<void> {
  await idbSet('appLock:lastActiveAt', Date.now());
}

/**
 * Evaluates whether the application should display the lock screen.
 * Returns true if:
 * 1. App lock is enabled, AND
 * 2. Either the app is already marked locked (persisted), OR
 * 3. Timeout is 0 (Immediately) and the context boundary occurred, OR
 * 4. Enough time has passed since last activity (> timeoutSeconds * 1000).
 */
export async function shouldBeLocked(isContextBoundary = false): Promise<boolean> {
  if (!(await isAppLockEnabled())) return false;
  if (await isAppLocked()) return true;

  const timeoutSeconds = await getAppLockTimeoutSeconds();
  const lastActiveAt = await getLastActiveAt();

  if (timeoutSeconds === 0) {
    // "Immediately" lock: if it's a context boundary (tab hide, blur, page reload), it must lock.
    if (isContextBoundary) {
      await setAppLocked(true);
      return true;
    }
    // If not marked locked yet and lastActiveAt was within current active interaction, check if expired
    return false;
  }

  const elapsed = Date.now() - lastActiveAt;
  if (elapsed >= timeoutSeconds * 1000) {
    await setAppLocked(true);
    return true;
  }
  return false;
}

