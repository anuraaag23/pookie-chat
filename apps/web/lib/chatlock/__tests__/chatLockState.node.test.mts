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
  getHiddenChatIds,
  hideChat,
  unhideChat,
  isChatHidden,
  getLockedChatIds,
  lockChat,
  unlockChatPermanently,
  isChatLocked,
  isChatSessionUnlocked,
  setChatSessionUnlocked,
  clearAllSessionUnlocked,
} from '../chatLockState.ts';

test('Chat Lock & Hide: hideChat, unhideChat, and isChatHidden state isolation', async () => {
  const userIdA = 'user-aaa-111';
  const userIdB = 'user-bbb-222';
  const convId1 = 'conv-111';
  const convId2 = 'conv-222';

  // Initially not hidden
  assert.equal(await isChatHidden(convId1, userIdA), false);
  assert.deepEqual(await getHiddenChatIds(userIdA), []);

  // Hide convId1 for userA
  await hideChat(convId1, userIdA);
  assert.equal(await isChatHidden(convId1, userIdA), true);
  assert.deepEqual(await getHiddenChatIds(userIdA), [convId1]);

  // Idempotent: hiding again does not duplicate
  await hideChat(convId1, userIdA);
  assert.deepEqual(await getHiddenChatIds(userIdA), [convId1]);

  // Hide convId2 for userA
  await hideChat(convId2, userIdA);
  assert.deepEqual(await getHiddenChatIds(userIdA), [convId1, convId2]);

  // User B's state is completely isolated
  assert.equal(await isChatHidden(convId1, userIdB), false);
  assert.deepEqual(await getHiddenChatIds(userIdB), []);

  // Unhide convId1 for userA
  await unhideChat(convId1, userIdA);
  assert.equal(await isChatHidden(convId1, userIdA), false);
  assert.equal(await isChatHidden(convId2, userIdA), true);
  assert.deepEqual(await getHiddenChatIds(userIdA), [convId2]);

  // Unhide convId2
  await unhideChat(convId2, userIdA);
  assert.deepEqual(await getHiddenChatIds(userIdA), []);
});

test('Chat Lock: lockChat, unlockChatPermanently, and session unlock cache', async () => {
  const userId = 'user-ccc-333';
  const convId = 'conv-lock-test';

  // Initially not locked
  assert.equal(await isChatLocked(convId, userId), false);
  assert.equal(isChatSessionUnlocked(convId), false);

  // Lock conversation
  await lockChat(convId, userId);
  assert.equal(await isChatLocked(convId, userId), true);
  assert.deepEqual(await getLockedChatIds(userId), [convId]);
  assert.equal(isChatSessionUnlocked(convId), false);

  // Authenticate session unlock for this tab
  setChatSessionUnlocked(convId, true);
  assert.equal(isChatSessionUnlocked(convId), true);

  // Locking again invalidates the session unlock cache immediately
  await lockChat(convId, userId);
  assert.equal(isChatSessionUnlocked(convId), false);

  // Unlock session again
  setChatSessionUnlocked(convId, true);
  assert.equal(isChatSessionUnlocked(convId), true);

  // Permanently unlock conversation
  await unlockChatPermanently(convId, userId);
  assert.equal(await isChatLocked(convId, userId), false);
  assert.equal(isChatSessionUnlocked(convId), false);
  assert.deepEqual(await getLockedChatIds(userId), []);
});

test('Chat Lock: clearAllSessionUnlocked purges all active session tokens', () => {
  const c1 = 'conv-s1';
  const c2 = 'conv-s2';

  setChatSessionUnlocked(c1, true);
  setChatSessionUnlocked(c2, true);
  assert.equal(isChatSessionUnlocked(c1), true);
  assert.equal(isChatSessionUnlocked(c2), true);

  clearAllSessionUnlocked();
  assert.equal(isChatSessionUnlocked(c1), false);
  assert.equal(isChatSessionUnlocked(c2), false);
});
