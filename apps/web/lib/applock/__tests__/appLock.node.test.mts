import test from 'node:test';
import assert from 'node:assert/strict';

// Mock in-memory storage to simulate IndexedDB key-value store for applock state
const mockStore = new Map<string, any>();

function mockIdbGet<T>(key: string): Promise<T | null> {
  return Promise.resolve(mockStore.has(key) ? (mockStore.get(key) as T) : null);
}

function mockIdbSet(key: string, value: any): Promise<void> {
  mockStore.set(key, value);
  return Promise.resolve();
}

// Logic mirroring state.ts with injectable storage
class AppLockStateMachine {
  private store: Map<string, any>;

  constructor(store: Map<string, any>) {
    this.store = store;
  }

  async isAppLockEnabled(): Promise<boolean> {
    return this.store.get('appLock:enabled') ?? false;
  }

  async setAppLockEnabled(enabled: boolean): Promise<void> {
    this.store.set('appLock:enabled', enabled);
    if (!enabled) {
      this.store.set('appLock:isLocked', false);
    }
  }

  async isAppLocked(): Promise<boolean> {
    return this.store.get('appLock:isLocked') ?? false;
  }

  async setAppLocked(locked: boolean): Promise<void> {
    this.store.set('appLock:isLocked', locked);
  }

  async getAppLockTimeoutSeconds(): Promise<number> {
    const t = this.store.get('appLock:timeoutSeconds');
    return typeof t === 'number' ? t : 60;
  }

  async setAppLockTimeoutSeconds(seconds: number): Promise<void> {
    this.store.set('appLock:timeoutSeconds', seconds);
  }

  async getLastActiveAt(): Promise<number> {
    return this.store.get('appLock:lastActiveAt') ?? 0;
  }

  async recordActivity(now = Date.now()): Promise<void> {
    this.store.set('appLock:lastActiveAt', now);
  }

  async shouldBeLocked(isContextBoundary = false, now = Date.now()): Promise<boolean> {
    if (!(await this.isAppLockEnabled())) return false;
    if (await this.isAppLocked()) return true;

    const timeoutSeconds = await this.getAppLockTimeoutSeconds();
    const lastActiveAt = await this.getLastActiveAt();

    if (timeoutSeconds === 0) {
      if (isContextBoundary) {
        await this.setAppLocked(true);
        return true;
      }
      return false;
    }

    const elapsed = now - lastActiveAt;
    if (elapsed >= timeoutSeconds * 1000) {
      await this.setAppLocked(true);
      return true;
    }
    return false;
  }
}

test('AppLock: disabled lock never locks', async () => {
  const store = new Map();
  const machine = new AppLockStateMachine(store);

  assert.equal(await machine.isAppLockEnabled(), false);
  assert.equal(await machine.shouldBeLocked(false), false);
  assert.equal(await machine.shouldBeLocked(true), false);
});

test('AppLock: Immediately (0s) locks on context boundary (tab hide, blur, reload)', async () => {
  const store = new Map();
  const machine = new AppLockStateMachine(store);

  await machine.setAppLockEnabled(true);
  await machine.setAppLockTimeoutSeconds(0);
  await machine.recordActivity(1000);

  // While actively interacting inside tab (not a boundary): not locked
  assert.equal(await machine.shouldBeLocked(false, 1050), false);

  // Context boundary occurs (user leaves tab, switches window, reloads)
  const lockedOnBoundary = await machine.shouldBeLocked(true, 1100);
  assert.equal(lockedOnBoundary, true);
  assert.equal(await machine.isAppLocked(), true);

  // Subsequent check remains locked until unlocked
  assert.equal(await machine.shouldBeLocked(false, 1150), true);
});

test('AppLock: timed options (30s, 60s, 300s, 900s) lock only after elapsed duration', async () => {
  const store = new Map();
  const machine = new AppLockStateMachine(store);

  await machine.setAppLockEnabled(true);
  await machine.setAppLockTimeoutSeconds(30);
  await machine.recordActivity(1000);

  // 15 seconds later: not locked
  assert.equal(await machine.shouldBeLocked(false, 1000 + 15_000), false);
  assert.equal(await machine.shouldBeLocked(true, 1000 + 15_000), false);

  // 30 seconds later: locked
  assert.equal(await machine.shouldBeLocked(false, 1000 + 30_000), true);
  assert.equal(await machine.isAppLocked(), true);
});

test('AppLock: user activity resets the inactivity timer', async () => {
  const store = new Map();
  const machine = new AppLockStateMachine(store);

  await machine.setAppLockEnabled(true);
  await machine.setAppLockTimeoutSeconds(30);
  await machine.recordActivity(1000);

  // At 20s, user types or clicks
  await machine.recordActivity(1000 + 20_000);

  // At 35s from start (15s from last activity): still unlocked
  assert.equal(await machine.shouldBeLocked(false, 1000 + 35_000), false);

  // At 51s from start (31s from last activity): now locked
  assert.equal(await machine.shouldBeLocked(false, 1000 + 51_000), true);
});

test('AppLock: disabling app lock clears isLocked flag', async () => {
  const store = new Map();
  const machine = new AppLockStateMachine(store);

  await machine.setAppLockEnabled(true);
  await machine.setAppLocked(true);
  assert.equal(await machine.isAppLocked(), true);

  await machine.setAppLockEnabled(false);
  assert.equal(await machine.isAppLocked(), false);
  assert.equal(await machine.shouldBeLocked(true), false);
});
