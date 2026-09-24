import test from 'node:test';
import assert from 'node:assert/strict';

// In-memory IndexedDB mock for Node.js test environment
const memoryStore = new Map();
if (typeof (globalThis as any).indexedDB === 'undefined') {
  (globalThis as any).indexedDB = {
    open: () => {
      const req: any = {
        result: {
          createObjectStore: () => {},
          transaction: () => {
            const tx: any = {
              objectStore: () => ({
                put: (val: any, key: string) => {
                  memoryStore.set(key, val);
                },
                get: (key: string) => {
                  const getReq: any = { result: memoryStore.get(key) };
                  setTimeout(() => getReq.onsuccess && getReq.onsuccess(), 1);
                  return getReq;
                },
                delete: (key: string) => {
                  memoryStore.delete(key);
                },
              }),
              oncomplete: null,
              onerror: null,
            };
            setTimeout(() => tx.oncomplete && tx.oncomplete(), 2);
            return tx;
          },
        },
      };
      setTimeout(() => {
        if (req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      }, 1);
      return req;
    },
  };
}

import {
  setAppLockEnabled,
  isAppLockEnabled,
  setAppLockVerifier,
  getAppLockVerifier,
  hasAppLockVerifier,
  verifyAppLockPin,
  changeAppLockPin,
  disableAppLockWithPin,
  setAppLocked,
  isAppLocked,
  setActiveAppLockUser,
  clearUserAppLock,
} from '../state.ts';
import { hashLocalSecret } from '../../localauth/localSecret.ts';

test('App Lock Hardening 1-3: Disable requires correct PIN, wrong PIN fails, correct PIN disables', async () => {
  const userId = 'user-test-disable';
  setActiveAppLockUser(userId);

  // Setup: Enable App Lock with PIN 1234
  const verifier = await hashLocalSecret('1234');
  await setAppLockVerifier(verifier, userId);
  await setAppLockEnabled(true, userId);

  assert.equal(await isAppLockEnabled(userId), true);
  assert.equal(await hasAppLockVerifier(userId), true);

  // 1. Cannot disable without PIN / empty PIN
  const emptyRes = await disableAppLockWithPin('', userId);
  assert.equal(emptyRes.success, false);
  assert.equal(await isAppLockEnabled(userId), true);

  // 2. Wrong PIN cannot disable
  const wrongRes = await disableAppLockWithPin('9999', userId);
  assert.equal(wrongRes.success, false);
  assert.equal(wrongRes.error, 'Current PIN is incorrect.');
  assert.equal(await isAppLockEnabled(userId), true);

  // 3. Correct PIN disables
  const correctRes = await disableAppLockWithPin('1234', userId);
  assert.equal(correctRes.success, true);
  assert.equal(await isAppLockEnabled(userId), false);
  assert.equal(await isAppLocked(userId), false);

  await clearUserAppLock(userId);
});

test('App Lock Hardening 4-8: Change PIN requires old PIN, validates new PIN, updates verifier', async () => {
  const userId = 'user-test-change';
  setActiveAppLockUser(userId);

  // Setup initial PIN 1234
  const verifier = await hashLocalSecret('1234');
  await setAppLockVerifier(verifier, userId);
  await setAppLockEnabled(true, userId);

  // 4 & 5. Wrong current PIN cannot change PIN
  const wrongOld = await changeAppLockPin('0000', '5678', userId);
  assert.equal(wrongOld.success, false);
  assert.equal(wrongOld.error, 'Current PIN is incorrect.');

  // Validate new PIN minimum length (4 digits)
  const shortNew = await changeAppLockPin('1234', '12', userId);
  assert.equal(shortNew.success, false);
  assert.equal(shortNew.error, 'New PIN must be at least 4 digits.');

  // Prevent setting identical PIN
  const sameNew = await changeAppLockPin('1234', '1234', userId);
  assert.equal(sameNew.success, false);
  assert.equal(sameNew.error, 'New PIN must be different from current PIN.');

  // 6. Correct current PIN allows PIN change
  const validChange = await changeAppLockPin('1234', '5678', userId);
  assert.equal(validChange.success, true);

  // 7. New PIN works after change
  assert.equal(await verifyAppLockPin('5678', userId), true);

  // 8. Old PIN stops working after change
  assert.equal(await verifyAppLockPin('1234', userId), false);

  await clearUserAppLock(userId);
});

test('App Lock Hardening 9-10: Existing PIN is detected and persists across session changes', async () => {
  const userId = 'user-persist-test';
  setActiveAppLockUser(userId);

  assert.equal(await hasAppLockVerifier(userId), false);

  const verifier = await hashLocalSecret('4321');
  await setAppLockVerifier(verifier, userId);
  await setAppLockEnabled(true, userId);

  // 9. Detected after initial set
  assert.equal(await hasAppLockVerifier(userId), true);
  assert.equal(await isAppLockEnabled(userId), true);

  // 10. Emulate reload/logout/login by resetting in-memory active user and re-resolving
  setActiveAppLockUser(null);
  assert.equal(await hasAppLockVerifier(userId), true);
  assert.equal(await isAppLockEnabled(userId), true);

  await clearUserAppLock(userId);
});

test('App Lock Hardening 11-14: Account isolation and state transitions', async () => {
  const userA = 'user-account-a';
  const userB = 'user-account-b';

  // User A configures PIN 1111
  const verifierA = await hashLocalSecret('1111');
  await setAppLockVerifier(verifierA, userA);
  await setAppLockEnabled(true, userA);
  await setAppLocked(true, userA);

  // 12. Account A's App Lock cannot leak into account B
  assert.equal(await isAppLockEnabled(userB), false);
  assert.equal(await hasAppLockVerifier(userB), false);
  assert.equal(await isAppLocked(userB), false);

  // 13. Disable on User A survives session switch
  const dis = await disableAppLockWithPin('1111', userA);
  assert.equal(dis.success, true);
  assert.equal(await isAppLockEnabled(userA), false);

  // Switch to User B and back to User A
  setActiveAppLockUser(userB);
  assert.equal(await isAppLockEnabled(userB), false);

  setActiveAppLockUser(userA);
  assert.equal(await isAppLockEnabled(userA), false);

  // 14. Locked state persistence
  await setAppLockEnabled(true, userA);
  await setAppLocked(true, userA);
  assert.equal(await isAppLocked(userA), true);

  await clearUserAppLock(userA);
  await clearUserAppLock(userB);
});
