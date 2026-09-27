import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Memory mock for tests
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

// Mock window and sessionStorage
if (typeof (globalThis as any).window === 'undefined') {
  const listeners = new Map<string, Function[]>();
  const storage = new Map<string, string>();
  (globalThis as any).window = {
    sessionStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v),
      removeItem: (k: string) => storage.delete(k),
    },
    addEventListener: (evt: string, cb: Function) => {
      const list = listeners.get(evt) || [];
      list.push(cb);
      listeners.set(evt, list);
    },
    removeEventListener: (evt: string, cb: Function) => {
      const list = listeners.get(evt) || [];
      listeners.set(evt, list.filter((l) => l !== cb));
    },
    dispatchEvent: (evt: any) => {
      const list = listeners.get(evt.type) || [];
      for (const cb of list) cb(evt);
      return true;
    },
  };
  (globalThis as any).CustomEvent = class CustomEvent {
    type: string;
    detail: any;
    constructor(type: string, opts?: any) {
      this.type = type;
      this.detail = opts?.detail;
    }
  };
}

import {
  isChatSessionUnlocked,
  setChatSessionUnlocked,
  clearAllSessionUnlocked,
  lockChat,
  unlockChatPermanently,
  isChatLocked,
  getLockedChatIds,
} from '../chatLockState.ts';

test('REQUIREMENT 1 & 2: Chat Room Header and Details Modal Information Architecture', () => {
  const roomPagePath = path.resolve(process.cwd(), 'apps/web/app/chat/room/[roomId]/page.tsx');
  assert.ok(fs.existsSync(roomPagePath), 'Room page exists');
  const content = fs.readFileSync(roomPagePath, 'utf8');

  // Verify Header contains only: avatar (#), room name, member count badge, and details button
  assert.ok(content.includes('#{room.name}'), 'Room header contains room name');
  assert.ok(content.includes('{room.memberCount}/{room.maxMembers}'), 'Room header contains compact count badge');
  assert.ok(content.includes('setShowRoomInfoModal(true)'), 'Room header has Details button');

  // Verify Header does NOT contain room code, copy button, stop joins, or close/delete
  // The header section is between "{/* Header */}" and "actionError"
  const headerMatch = content.match(/{\/\* Header \*\/}([\s\S]*?)(?={\/\* Key Synchronization|\{actionError)/);
  assert.ok(headerMatch, 'Header block identified');
  const headerContent = headerMatch[1];

  assert.ok(!headerContent.includes('handleCopyCode'), 'Header does NOT expose copy code');
  assert.ok(!headerContent.includes('handleToggleJoinLock'), 'Header does NOT expose stop joins');
  assert.ok(!headerContent.includes("setConfirmModal({ type: 'delete' })"), 'Header does NOT expose close room');
  assert.ok(!headerContent.includes("setConfirmModal({ type: 'leave' })"), 'Header does NOT expose leave room');

  // Verify Room Details Modal contains the relocated controls:
  assert.ok(content.includes('Room Code'), 'Modal displays room code');
  assert.ok(content.includes('Room Join Lock'), 'Modal displays join lock toggle in owner settings');
  assert.ok(content.includes('Close & Delete Room'), 'Modal displays Close & Delete Room for owner');
  assert.ok(content.includes('Leave Room'), 'Modal displays Leave Room for non-owner');
});

test('REQUIREMENT 2: 1:1 Contact Profile Actions Consolidation', () => {
  const directChatPath = path.resolve(process.cwd(), 'apps/web/app/chat/[conversationId]/page.tsx');
  assert.ok(fs.existsSync(directChatPath), 'Conversation page exists');
  const content = fs.readFileSync(directChatPath, 'utf8');

  // Verify Header has profile button
  assert.ok(content.includes('setShowProfileModal(true)'), 'Header opens profile modal');

  // Verify Profile Sheet contains Lock/Unlock, Hide/Unhide, Block/Unblock, Burn
  assert.ok(content.includes('Privacy & Security'), 'Profile modal has Privacy & Security section');
  assert.ok(content.includes('isLocked ? \'Remove Chat Lock\' : \'Lock Chat\''), 'Profile modal has Chat Lock button');
  assert.ok(content.includes('isHidden ? \'Unhide Chat\' : \'Hide Chat\''), 'Profile modal has Hide Chat button');
  assert.ok(content.includes('Unblock Contact'), 'Profile modal has Unblock Contact');
  assert.ok(content.includes('Block Contact'), 'Profile modal has Block Contact');
  assert.ok(content.includes('Burn Conversation'), 'Profile modal has Burn Conversation');

  // Verify feature password setup flows in confirmAction:
  assert.ok(content.includes("confirmAction === 'remove-lock'"), 'Handles remove-lock confirmation');
  assert.ok(content.includes("confirmAction === 'lock-setup'"), 'Handles lock password setup confirmation');
  assert.ok(content.includes("confirmAction === 'hide-setup'"), 'Handles hide password setup confirmation');
  assert.ok(content.includes("confirmAction === 'burn'"), 'Handles burn confirmation with setup');
});

test('REQUIREMENT 4: Chat Room Key Recovery and Sync Banner', () => {
  const roomPagePath = path.resolve(process.cwd(), 'apps/web/app/chat/room/[roomId]/page.tsx');
  const content = fs.readFileSync(roomPagePath, 'utf8');

  // Verify syncRoomKey helper exists
  assert.ok(content.includes('syncRoomKey'), 'syncRoomKey function exists');
  assert.ok(content.includes('isSyncingKey'), 'isSyncingKey state exists');
  assert.ok(content.includes('keySyncError'), 'keySyncError state exists');

  // Verify Key Sync Status Banner is rendered
  assert.ok(content.includes('Key Synchronization Status Banner'), 'Key Sync Banner rendered');
  assert.ok(content.includes('Retry'), 'Key Sync Banner has Retry button');

  // Verify socket event triggers for real-time recovery
  assert.ok(content.includes("socket.on('room:key_delivered'"), 'Listens for room:key_delivered');
  assert.ok(content.includes("socket.on('room:join_accepted'"), 'Listens for room:join_accepted');

  // Verify composer placeholder never lies
  assert.ok(content.includes('Room key required to send messages'), 'Honest composer placeholder when key is missing');
});

test('REQUIREMENT 5: Chat Lock Session and Setup Recovery', async () => {
  const directChatPath = path.resolve(process.cwd(), 'apps/web/app/chat/[conversationId]/page.tsx');
  const content = fs.readFileSync(directChatPath, 'utf8');

  // Verify locked screen renders setup form when !hasChatLockPassword
  assert.ok(content.includes('Set Up Chat Lock Password'), 'Setup form rendered when password not configured');
  assert.ok(content.includes('handleSetupChatLockAndUnlock'), 'Setup handler unlocks session on completion');

  // Verify sessionStorage & event dispatch in chatLockState
  const convId = 'test-lock-sync-conv';
  setChatSessionUnlocked(convId, true);
  assert.equal(isChatSessionUnlocked(convId), true);
  assert.equal(window.sessionStorage.getItem(`chatLock:unlocked:${convId}`), 'true');

  setChatSessionUnlocked(convId, false);
  assert.equal(isChatSessionUnlocked(convId), false);
  assert.equal(window.sessionStorage.getItem(`chatLock:unlocked:${convId}`), null);
});

test('REQUIREMENT 6: Realtime Presence & Connection Heartbeat', () => {
  const gatewayPath = path.resolve(process.cwd(), 'apps/backend/src/realtime/realtime.gateway.ts');
  const gatewayContent = fs.readFileSync(gatewayPath, 'utf8');

  // Verify socket heartbeat pingInterval and pingTimeout
  assert.ok(gatewayContent.includes('pingInterval: 10000'), 'Socket.io pingInterval configured to 10s');
  assert.ok(gatewayContent.includes('pingTimeout: 5000'), 'Socket.io pingTimeout configured to 5s');

  // Verify registry method getConnectionCount exists
  const regPath = path.resolve(process.cwd(), 'apps/backend/src/realtime/connection-registry.service.ts');
  const regContent = fs.readFileSync(regPath, 'utf8');
  assert.ok(regContent.includes('getConnectionCount(userId: string): number'), 'getConnectionCount method exists in registry');

  // Verify functional state updaters in frontend chat page to avoid stale closures
  const chatPagePath = path.resolve(process.cwd(), 'apps/web/app/chat/[conversationId]/page.tsx');
  const chatPageContent = fs.readFileSync(chatPagePath, 'utf8');
  assert.ok(chatPageContent.includes('setOtherUser((prev) =>'), 'Uses functional state updater for socket presence');
});
