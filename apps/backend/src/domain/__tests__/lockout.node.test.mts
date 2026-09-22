import test from 'node:test';
import assert from 'node:assert/strict';
import { isLoginLocked, recordFailedLogin, clearLoginLockout } from '../lockout.ts';

test('lockout: does not lock before the threshold', () => {
  let state = clearLoginLockout();
  for (let i = 0; i < 4; i++) state = recordFailedLogin(state, new Date('2026-01-01T00:00:00Z'));
  assert.equal(isLoginLocked(state, new Date('2026-01-01T00:00:00Z')), false);
});

test('lockout: locks after the threshold and expires after the window', () => {
  let state = clearLoginLockout();
  const now = new Date('2026-01-01T00:00:00Z');
  for (let i = 0; i < 5; i++) state = recordFailedLogin(state, now);
  assert.equal(isLoginLocked(state, now), true);
  assert.equal(isLoginLocked(state, new Date(now.getTime() + 31_000)), false);
});

test('lockout: escalates on repeated post-threshold failures', () => {
  let state = clearLoginLockout();
  const now = new Date('2026-01-01T00:00:00Z');
  for (let i = 0; i < 5; i++) state = recordFailedLogin(state, now);
  const firstLockUntil = state.lockedUntil.getTime();
  state = recordFailedLogin(state, now); // 6th failure, still "locked" in wall-clock terms but let's simulate it happening right at expiry
  const secondLockUntil = state.lockedUntil.getTime();
  assert.ok(secondLockUntil > firstLockUntil, 'lockout window should grow, not repeat the same duration');
});

test('lockout: successful login clears the counter', () => {
  const cleared = clearLoginLockout();
  assert.equal(cleared.failedLoginCount, 0);
  assert.equal(cleared.lockedUntil, null);
});
