import { idbGet, idbSet } from '../storage/localDb';

export async function isAppLockEnabled(): Promise<boolean> {
  return (await idbGet<boolean>('appLock:enabled')) ?? false;
}

export async function setAppLockEnabled(enabled: boolean): Promise<void> {
  await idbSet('appLock:enabled', enabled);
}

export async function getAppLockTimeoutSeconds(): Promise<number> {
  return (await idbGet<number>('appLock:timeoutSeconds')) ?? 60;
}

export async function setAppLockTimeoutSeconds(seconds: number): Promise<void> {
  await idbSet('appLock:timeoutSeconds', seconds);
}

export async function recordActivity(): Promise<void> {
  await idbSet('appLock:lastActiveAt', Date.now());
}

/** True if enough time has passed since the last recorded activity that the app should re-lock — checked on load and on tab-visibility change, not on a running timer (which would need to survive the tab being backgrounded anyway). */
export async function shouldBeLocked(): Promise<boolean> {
  if (!(await isAppLockEnabled())) return false;
  const lastActiveAt = (await idbGet<number>('appLock:lastActiveAt')) ?? 0;
  const timeoutSeconds = await getAppLockTimeoutSeconds();
  return Date.now() - lastActiveAt > timeoutSeconds * 1000;
}
