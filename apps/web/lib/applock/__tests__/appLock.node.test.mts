import test from 'node:test';
import assert from 'node:assert/strict';
import { AppLockStateMachine, type AppLockStorageAdapter } from '../lifecycle.ts';

class InMemoryAppLockStorage implements AppLockStorageAdapter {
  public store = new Map<string, any>();

  async isAppLockEnabled(userId?: string | null): Promise<boolean> {
    if (!userId) return false;
    const enabled = this.store.get(`appLock:${userId}:enabled`) ?? false;
    const verifier = this.store.get(`appLock:${userId}:verifier`);
    return enabled && !!verifier;
  }

  async isAppLocked(userId?: string | null): Promise<boolean> {
    if (!userId) return false;
    return this.store.get(`appLock:${userId}:isLocked`) ?? false;
  }

  async setAppLocked(locked: boolean, userId?: string | null): Promise<void> {
    if (!userId) return;
    this.store.set(`appLock:${userId}:isLocked`, locked);
  }

  async getAppLockTimeoutSeconds(userId?: string | null): Promise<number> {
    if (!userId) return 60;
    const t = this.store.get(`appLock:${userId}:timeoutSeconds`);
    return typeof t === 'number' ? t : 60;
  }

  async setAppLockTimeoutSeconds(seconds: number, userId?: string | null): Promise<void> {
    if (!userId) return;
    this.store.set(`appLock:${userId}:timeoutSeconds`, seconds);
  }

  async getAppLockVerifier(userId?: string | null): Promise<string | null> {
    if (!userId) return null;
    return this.store.get(`appLock:${userId}:verifier`) ?? null;
  }

  async setAppLockVerifier(verifier: string, userId?: string | null): Promise<void> {
    if (!userId) return;
    this.store.set(`appLock:${userId}:verifier`, verifier);
  }

  async setAppLockEnabled(enabled: boolean, userId?: string | null): Promise<void> {
    if (!userId) return;
    this.store.set(`appLock:${userId}:enabled`, enabled);
    if (!enabled) {
      this.store.set(`appLock:${userId}:isLocked`, false);
    }
  }

  async getLastActiveAt(userId?: string | null): Promise<number> {
    if (!userId) return 0;
    return this.store.get(`appLock:${userId}:lastActiveAt`) ?? 0;
  }

  async recordActivity(userId?: string | null, now = Date.now()): Promise<void> {
    if (!userId) return;
    this.store.set(`appLock:${userId}:lastActiveAt`, now);
  }

  async checkLocalSecret(input: string, storedVerifier: string | null): Promise<boolean> {
    if (!storedVerifier) return false;
    return input === storedVerifier || storedVerifier === `hash:${input}`;
  }

  clearAuthSession(): void {
    for (const key of Array.from(this.store.keys())) {
      if (!key.startsWith('appLock:')) {
        this.store.delete(key);
      }
    }
  }
}

test('1. Disabled App Lock: never transitions to locked and remains disabled', async () => {
  const storage = new InMemoryAppLockStorage();
  const machine = new AppLockStateMachine({ storage });

  const state = await machine.init(true, 'user-1');
  assert.equal(state, 'disabled');
  assert.equal(machine.getState(), 'disabled');

  await machine.handleDeparture('blur');
  assert.equal(machine.getState(), 'disabled');

  await machine.handleReturn('focus');
  assert.equal(machine.getState(), 'disabled');

  await machine.checkInactivity(Date.now() + 999999);
  assert.equal(machine.getState(), 'disabled');
  assert.equal(await storage.isAppLocked('user-1'), false);
});

test('2. Immediate mode while app remains active: NOT locked', async () => {
  const storage = new InMemoryAppLockStorage();
  await storage.setAppLockEnabled(true, 'user-1');
  await storage.setAppLockVerifier('hash:1234', 'user-1');
  await storage.setAppLockTimeoutSeconds(0, 'user-1'); // Immediately

  const t0 = 10000;
  const machine = new AppLockStateMachine({ storage });
  const state = await machine.init(true, 'user-1', t0);
  assert.equal(state, 'unlocked');

  // Continuous user activity in foreground
  await machine.handleUserActivity(t0 + 200);
  await machine.handleUserActivity(t0 + 400);

  const check = await machine.checkInactivity(t0 + 800);
  assert.equal(check, 'unlocked');
  assert.equal(machine.getState(), 'unlocked');
  assert.equal(await storage.isAppLocked('user-1'), false);
});

test('3. Immediate mode + confirmed app departure: locks after grace period', async () => {
  const storage = new InMemoryAppLockStorage();
  await storage.setAppLockEnabled(true, 'user-1');
  await storage.setAppLockVerifier('hash:1234', 'user-1');
  await storage.setAppLockTimeoutSeconds(0, 'user-1');

  const t0 = 10000;
  const machine = new AppLockStateMachine({ storage, gracePeriodMs: 1500 });
  await machine.init(true, 'user-1', t0);

  // User departs app context (tab hidden)
  await machine.handleDeparture('hidden', t0);
  assert.equal(machine.getState(), 'pending-departure');

  // Confirmed departure: user returns after grace period (1500ms)
  const returnState = await machine.handleReturn('visible', t0 + 1500);
  assert.equal(returnState, 'locked');
  assert.equal(machine.getState(), 'locked');
  assert.equal(await storage.isAppLocked('user-1'), true);
});

test('4. Immediate mode + short transient visibility/focus loss: NOT locked', async () => {
  const storage = new InMemoryAppLockStorage();
  await storage.setAppLockEnabled(true, 'user-1');
  await storage.setAppLockVerifier('hash:1234', 'user-1');
  await storage.setAppLockTimeoutSeconds(0, 'user-1');

  const t0 = 10000;
  const machine = new AppLockStateMachine({ storage, gracePeriodMs: 1500 });
  await machine.init(true, 'user-1', t0);

  // Transient blur event (e.g. browser permission dialog, notification shade swipe)
  await machine.handleDeparture('blur', t0);
  assert.equal(machine.getState(), 'pending-departure');

  // Fast return: 400ms (< 1500ms grace period)
  const returnState = await machine.handleReturn('focus', t0 + 400);
  assert.equal(returnState, 'unlocked');
  assert.equal(machine.getState(), 'unlocked');
  assert.equal(await storage.isAppLocked('user-1'), false);
});

test('5. Immediate mode + return during grace period: pending lock cancelled', async () => {
  const storage = new InMemoryAppLockStorage();
  await storage.setAppLockEnabled(true, 'user-1');
  await storage.setAppLockVerifier('hash:1234', 'user-1');
  await storage.setAppLockTimeoutSeconds(0, 'user-1');

  const t0 = 10000;
  const machine = new AppLockStateMachine({ storage, gracePeriodMs: 50 }); // 50ms timer for testing timer cancellation
  await machine.init(true, 'user-1', t0);

  await machine.handleDeparture('hidden', t0);
  assert.equal(machine.getState(), 'pending-departure');

  // Return at 20ms (< 50ms)
  await machine.handleReturn('visible', t0 + 20);
  assert.equal(machine.getState(), 'unlocked');

  // Wait beyond the original 50ms timer to ensure it does not fire and lock
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(machine.getState(), 'unlocked');
  assert.equal(await storage.isAppLocked('user-1'), false);
});

test('6. Immediate mode + browser/tab switch: locks upon confirmed return', async () => {
  const storage = new InMemoryAppLockStorage();
  await storage.setAppLockEnabled(true, 'user-1');
  await storage.setAppLockVerifier('hash:1234', 'user-1');
  await storage.setAppLockTimeoutSeconds(0, 'user-1');

  const t0 = 10000;
  const machine = new AppLockStateMachine({ storage, gracePeriodMs: 1500 });
  await machine.init(true, 'user-1', t0);

  // Tab switch
  await machine.handleDeparture('pagehide', t0);
  assert.equal(machine.getState(), 'pending-departure');

  // User spends 5 seconds in another tab, then switches back
  const state = await machine.handleReturn('pageshow', t0 + 5000);
  assert.equal(state, 'locked');
  assert.equal(await storage.isAppLocked('user-1'), true);
});

test('7. Timed 30s expiry: locks only after full 30s elapsed', async () => {
  const storage = new InMemoryAppLockStorage();
  await storage.setAppLockEnabled(true, 'user-1');
  await storage.setAppLockVerifier('hash:1234', 'user-1');
  await storage.setAppLockTimeoutSeconds(30, 'user-1');

  const t0 = 10000;
  const machine = new AppLockStateMachine({ storage });
  await machine.init(true, 'user-1', t0);
  await storage.recordActivity('user-1', t0);

  // Transient blur does not enter pending-departure in timed mode
  await machine.handleDeparture('blur', t0 + 5000);
  assert.equal(machine.getState(), 'unlocked');

  // Check at 29s: still unlocked
  const state29 = await machine.checkInactivity(t0 + 29_000);
  assert.equal(state29, 'unlocked');
  assert.equal(machine.getState(), 'unlocked');

  // Check at 30s: locked
  const state30 = await machine.checkInactivity(t0 + 30_000);
  assert.equal(state30, 'locked');
  assert.equal(machine.getState(), 'locked');
  assert.equal(await storage.isAppLocked('user-1'), true);
});

test('8. Timed activity reset: resets inactivity timer', async () => {
  const storage = new InMemoryAppLockStorage();
  await storage.setAppLockEnabled(true, 'user-1');
  await storage.setAppLockVerifier('hash:1234', 'user-1');
  await storage.setAppLockTimeoutSeconds(30, 'user-1');

  const t0 = 10000;
  const machine = new AppLockStateMachine({ storage });
  await machine.init(true, 'user-1', t0);
  await storage.recordActivity('user-1', t0);

  // At 20s, user types/clicks
  await machine.handleUserActivity(t0 + 20_000);

  // At 35s from start (only 15s from last activity): still unlocked
  const state35 = await machine.checkInactivity(t0 + 35_000);
  assert.equal(state35, 'unlocked');

  // At 51s from start (31s from last activity): locked
  const state51 = await machine.checkInactivity(t0 + 51_000);
  assert.equal(state51, 'locked');
  assert.equal(await storage.isAppLocked('user-1'), true);
});

test('9. Timed timeout after inactivity on return', async () => {
  const storage = new InMemoryAppLockStorage();
  await storage.setAppLockEnabled(true, 'user-1');
  await storage.setAppLockVerifier('hash:1234', 'user-1');
  await storage.setAppLockTimeoutSeconds(30, 'user-1');

  const t0 = 10000;
  const machine = new AppLockStateMachine({ storage });
  await machine.init(true, 'user-1', t0);
  await storage.recordActivity('user-1', t0);

  // Returning after 45s of inactivity
  const returnState = await machine.handleReturn('visible', t0 + 45_000);
  assert.equal(returnState, 'locked');
  assert.equal(machine.getState(), 'locked');
});

test('10. Logout -> login preserves App Lock configuration', async () => {
  const storage = new InMemoryAppLockStorage();
  await storage.setAppLockEnabled(true, 'user-1');
  await storage.setAppLockVerifier('hash:1234', 'user-1');
  await storage.setAppLockTimeoutSeconds(0, 'user-1');

  const machine = new AppLockStateMachine({ storage });
  await machine.init(true, 'user-1');
  assert.equal(machine.getState(), 'unlocked');

  // User logs out: clearAuthState preserves appLock:*
  await machine.handleLogout();
  storage.clearAuthSession();

  // Verify settings survived in persistent local storage
  assert.equal(await storage.isAppLockEnabled('user-1'), true);
  assert.equal(await storage.getAppLockVerifier('user-1'), 'hash:1234');
  assert.equal(await storage.isAppLocked('user-1'), true);

  // User logs back in
  const postLoginState = await machine.handleLogin('user-1', true);
  assert.equal(postLoginState, 'locked'); // Must be locked on return login
  assert.equal(machine.getState(), 'locked');
});

test('11. Logout -> login restores correct timeout', async () => {
  const storage = new InMemoryAppLockStorage();
  await storage.setAppLockEnabled(true, 'user-1');
  await storage.setAppLockVerifier('hash:1234', 'user-1');
  await storage.setAppLockTimeoutSeconds(300, 'user-1'); // 5 minutes

  const machine = new AppLockStateMachine({ storage });
  await machine.init(true, 'user-1');
  await machine.handleLogout();
  storage.clearAuthSession();

  // User logs back in
  await machine.handleLogin('user-1', true);
  const timeout = await storage.getAppLockTimeoutSeconds('user-1');
  assert.equal(timeout, 300);
});

test('12. Logout -> login restores PIN verification', async () => {
  const storage = new InMemoryAppLockStorage();
  await storage.setAppLockEnabled(true, 'user-1');
  await storage.setAppLockVerifier('hash:5678', 'user-1');
  await storage.setAppLockTimeoutSeconds(60, 'user-1');

  const machine = new AppLockStateMachine({ storage });
  await machine.init(true, 'user-1');
  await machine.handleLogout();
  storage.clearAuthSession();

  // Log in
  await machine.handleLogin('user-1', true);
  assert.equal(machine.getState(), 'locked');

  // Try wrong PIN
  const wrongRes = await machine.attemptUnlock('1234');
  assert.equal(wrongRes, false);
  assert.equal(machine.getState(), 'locked');

  // Try correct PIN
  const correctRes = await machine.attemptUnlock('5678');
  assert.equal(correctRes, true);
  assert.equal(machine.getState(), 'unlocked');
  assert.equal(await storage.isAppLocked('user-1'), false);
});

test('13. PIN change survives logout/login', async () => {
  const storage = new InMemoryAppLockStorage();
  await storage.setAppLockEnabled(true, 'user-1');
  await storage.setAppLockVerifier('hash:1111', 'user-1');

  const machine = new AppLockStateMachine({ storage });
  await machine.init(true, 'user-1');

  // Change PIN to 9999
  await storage.setAppLockVerifier('hash:9999', 'user-1');

  // Logout and login
  await machine.handleLogout();
  storage.clearAuthSession();
  await machine.handleLogin('user-1', true);

  // Old PIN fails
  assert.equal(await machine.attemptUnlock('1111'), false);
  assert.equal(machine.getState(), 'locked');

  // New PIN succeeds
  assert.equal(await machine.attemptUnlock('9999'), true);
  assert.equal(machine.getState(), 'unlocked');
});

test('14. Disable App Lock survives logout/login', async () => {
  const storage = new InMemoryAppLockStorage();
  await storage.setAppLockEnabled(true, 'user-1');
  await storage.setAppLockVerifier('hash:1234', 'user-1');

  const machine = new AppLockStateMachine({ storage });
  await machine.init(true, 'user-1');

  // Disable App Lock
  await storage.setAppLockEnabled(false, 'user-1');

  // Logout and login
  await machine.handleLogout();
  storage.clearAuthSession();
  const state = await machine.handleLogin('user-1', true);

  assert.equal(state, 'disabled');
  assert.equal(machine.getState(), 'disabled');
});

test('15. Refresh cannot bypass lock', async () => {
  const storage = new InMemoryAppLockStorage();
  await storage.setAppLockEnabled(true, 'user-1');
  await storage.setAppLockVerifier('hash:1234', 'user-1');
  await storage.setAppLocked(true, 'user-1');

  // Refresh creates a brand new StateMachine instance
  const refreshedMachine = new AppLockStateMachine({ storage });
  const state = await refreshedMachine.init(true, 'user-1');

  assert.equal(state, 'locked');
  assert.equal(refreshedMachine.getState(), 'locked');
});

test('16. Already locked state cannot be auto-unlocked by focus/visibility events', async () => {
  const storage = new InMemoryAppLockStorage();
  await storage.setAppLockEnabled(true, 'user-1');
  await storage.setAppLockVerifier('hash:1234', 'user-1');
  await storage.setAppLocked(true, 'user-1');

  const machine = new AppLockStateMachine({ storage });
  await machine.init(true, 'user-1');
  assert.equal(machine.getState(), 'locked');

  // Returning to tab / gaining focus must NEVER unlock
  const vState = await machine.handleReturn('visible');
  assert.equal(vState, 'locked');

  const fState = await machine.handleReturn('focus');
  assert.equal(fState, 'locked');

  const pState = await machine.handleReturn('pageshow');
  assert.equal(pState, 'locked');

  assert.equal(machine.getState(), 'locked');
  assert.equal(await storage.isAppLocked('user-1'), true);
});

test('17. Different account in same browser cannot inherit another account\'s local lock state', async () => {
  const storage = new InMemoryAppLockStorage();
  
  // Alice configures App Lock
  await storage.setAppLockEnabled(true, 'alice');
  await storage.setAppLockVerifier('hash:1111', 'alice');
  await storage.setAppLockTimeoutSeconds(0, 'alice');

  const machine = new AppLockStateMachine({ storage });
  await machine.init(true, 'alice');
  assert.equal(machine.getState(), 'unlocked');

  // Alice logs out
  await machine.handleLogout();
  storage.clearAuthSession();

  // Bob logs into the same browser. Bob has never set up App Lock.
  const bobState = await machine.handleLogin('bob', true);
  assert.equal(bobState, 'disabled');
  assert.equal(machine.getState(), 'disabled');

  // Bob sets up his own PIN '2222' with 60s timeout
  await storage.setAppLockVerifier('hash:2222', 'bob');
  await storage.setAppLockEnabled(true, 'bob');
  await storage.setAppLockTimeoutSeconds(60, 'bob');

  // Bob logs out
  await machine.handleLogout();
  storage.clearAuthSession();

  // Alice logs back in: she gets HER lock state, not Bob's
  const aliceState = await machine.handleLogin('alice', true);
  assert.equal(aliceState, 'locked');
  assert.equal(await storage.getAppLockTimeoutSeconds('alice'), 0);

  // Bob's PIN fails on Alice's account
  assert.equal(await machine.attemptUnlock('2222'), false);
  // Alice's PIN succeeds
  assert.equal(await machine.attemptUnlock('1111'), true);
  assert.equal(machine.getState(), 'unlocked');
});
