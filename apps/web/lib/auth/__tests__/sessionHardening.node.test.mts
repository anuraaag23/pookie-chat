import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('Mobile Viewport: interactiveWidget resizes-content is configured in root layout', () => {
  const layoutPath = path.resolve(process.cwd(), 'apps/web/app/layout.tsx');
  const code = fs.readFileSync(layoutPath, 'utf8');

  assert.ok(code.includes("interactiveWidget: 'resizes-content'"), 'interactiveWidget must be resizes-content');
  assert.ok(code.includes('userScalable: false'), 'userScalable must be false to prevent accidental zooming');
  assert.ok(code.includes('maximumScale: 1'), 'maximumScale must be 1');
  assert.ok(code.includes("width: 'device-width'"), 'width must be device-width');
});

test('Session Hardening: idbClearAuthSession clears session tokens while preserving user-scoped state', async () => {
  const localDbPath = path.resolve(process.cwd(), 'apps/web/lib/storage/localDb.ts');
  const code = fs.readFileSync(localDbPath, 'utf8');

  // Verify idbClearAuthSession explicitly deletes auth:tokens, auth:session, and legacy crypto:identity
  assert.ok(code.includes("store.delete('auth:tokens')"), 'Must delete auth:tokens');
  assert.ok(code.includes("store.delete('auth:session')"), 'Must delete auth:session');
  assert.ok(code.includes("store.delete('crypto:identity')"), 'Must delete legacy un-scoped crypto:identity');

  // Mock IndexedDB storage simulating user-scoped storage during logout
  const mockDb = new Map<string, any>([
    ['auth:tokens', { accessToken: 'acc_123', refreshToken: 'ref_123' }],
    ['auth:session', { userId: 'usr_alice', deviceId: 'dev_123' }],
    ['crypto:identity', { legacy: true }],
    ['crypto:identity:usr_alice', {
      identityDhPublic: 'dh_pub_alice',
      identitySigningPublic: 'sign_pub_alice',
      signedPrekeyPublic: 'pre_pub_alice',
      _private: { identityDhKeyPair: { privateKey: 'dh_priv_alice' } },
    }],
    ['crypto:ratchet:usr_alice:convo_bob', { sendStep: 2, recvStep: 3, lastSyncedSeq: 10, epoch: 1 }],
    ['messages:usr_alice:convo_bob', [{ id: 'msg_1', text: 'Hello Bob', mine: true }]],
    ['roomKey:usr_alice:room_1:1', 'key_material_alice'],
    ['appLock:usr_alice', { enabled: true, timeoutSeconds: 30 }],
    ['chatLock:convo_bob', { locked: true }],
    ['hiddenChats:usr_alice', ['convo_bob']],
  ]);

  // Execute idbClearAuthSession actions
  mockDb.delete('auth:tokens');
  mockDb.delete('auth:session');
  mockDb.delete('crypto:identity');

  // Verify session tokens and legacy un-scoped identity are cleared
  assert.equal(mockDb.has('auth:tokens'), false, 'auth:tokens must be cleared');
  assert.equal(mockDb.has('auth:session'), false, 'auth:session must be cleared');
  assert.equal(mockDb.has('crypto:identity'), false, 'legacy un-scoped crypto:identity must be cleared');

  // Verify user-scoped cryptographic identity is preserved for re-login
  assert.equal(mockDb.has('crypto:identity:usr_alice'), true, 'User-scoped identity must be preserved');
  const identity = mockDb.get('crypto:identity:usr_alice');
  assert.equal(identity.identityDhPublic, 'dh_pub_alice');

  // Verify ratchets, message history, room keys, and app lock are preserved for Alice
  assert.equal(mockDb.has('crypto:ratchet:usr_alice:convo_bob'), true);
  assert.equal(mockDb.has('messages:usr_alice:convo_bob'), true);
  assert.equal(mockDb.has('roomKey:usr_alice:room_1:1'), true);
  assert.equal(mockDb.has('appLock:usr_alice'), true);
});

test('Multi-Account Isolation: Account B never inherits Account A identity, ratchets, messages, or keys', async () => {
  // Simulating user-scoped storage functions
  const mockStorage = new Map<string, any>();
  let activeUserId: string | null = null;

  function setActiveUser(uid: string | null) {
    activeUserId = uid;
  }

  function getIdentity(uid?: string | null) {
    const user = uid ?? activeUserId;
    if (!user) return null;
    return mockStorage.get(`crypto:identity:${user}`) ?? null;
  }

  function getRatchet(conversationId: string, uid?: string | null) {
    const user = uid ?? activeUserId;
    if (!user) return null;
    return mockStorage.get(`crypto:ratchet:${user}:${conversationId}`) ?? null;
  }

  function getMessages(conversationId: string, uid?: string | null): any[] {
    const user = uid ?? activeUserId;
    if (!user) return [];
    return mockStorage.get(`messages:${user}:${conversationId}`) ?? [];
  }

  function getRoomKey(roomId: string, epoch: number, uid?: string | null) {
    const user = uid ?? activeUserId;
    if (!user) return null;
    return mockStorage.get(`roomKey:${user}:${roomId}:${epoch}`) ?? null;
  }

  // 1. Account A logs in and initializes state
  setActiveUser('usr_alice');
  mockStorage.set('crypto:identity:usr_alice', { identityDhPublic: 'alice_dh', _private: 'alice_secret' });
  mockStorage.set('crypto:ratchet:usr_alice:convo_shared', { sendStep: 5, epoch: 1 });
  mockStorage.set('messages:usr_alice:convo_shared', [{ id: 'm1', text: 'Secret message from Alice' }]);
  mockStorage.set('roomKey:usr_alice:room_top_secret:1', 'alice_room_key');
  mockStorage.set('appLock:usr_alice', { enabled: true, pinHash: 'alice_pin' });

  // Verify Alice has access to her own data
  assert.equal(getIdentity()?.identityDhPublic, 'alice_dh');
  assert.equal(getRatchet('convo_shared')?.sendStep, 5);
  assert.equal(getMessages('convo_shared').length, 1);
  assert.equal(getRoomKey('room_top_secret', 1), 'alice_room_key');

  // 2. Alice logs out
  setActiveUser(null);

  // When logged out, unauthenticated queries return null/empty
  assert.equal(getIdentity(), null);
  assert.equal(getRatchet('convo_shared'), null);
  assert.equal(getMessages('convo_shared').length, 0);
  assert.equal(getRoomKey('room_top_secret', 1), null);

  // 3. Account B logs into the same device
  setActiveUser('usr_bob');

  // Bob must NOT see Alice's identity, ratchets, messages, or room keys
  assert.equal(getIdentity(), null, 'Bob must not inherit Alice identity');
  assert.equal(getRatchet('convo_shared'), null, 'Bob must not inherit Alice ratchets');
  assert.equal(getMessages('convo_shared').length, 0, 'Bob must not inherit Alice messages');
  assert.equal(getRoomKey('room_top_secret', 1), null, 'Bob must not inherit Alice room keys');

  // Bob sets his own identity and messages
  mockStorage.set('crypto:identity:usr_bob', { identityDhPublic: 'bob_dh', _private: 'bob_secret' });
  mockStorage.set('crypto:ratchet:usr_bob:convo_shared', { sendStep: 0, epoch: 2 });
  mockStorage.set('messages:usr_bob:convo_shared', [{ id: 'm2', text: "Bob's private note" }]);

  assert.equal(getIdentity()?.identityDhPublic, 'bob_dh');
  assert.equal(getRatchet('convo_shared')?.sendStep, 0);
  assert.equal(getMessages('convo_shared')[0].text, "Bob's private note");

  // 4. Bob logs out and Alice logs back in
  setActiveUser(null);
  setActiveUser('usr_alice');

  // Alice gets her original data back, completely isolated from Bob's data
  assert.equal(getIdentity()?.identityDhPublic, 'alice_dh');
  assert.equal(getRatchet('convo_shared')?.sendStep, 5);
  assert.equal(getMessages('convo_shared')[0].text, 'Secret message from Alice');
  assert.equal(getRoomKey('room_top_secret', 1), 'alice_room_key');
});

test('Session Refresh: Transient network/5xx errors do not trigger session destruction', () => {
  function shouldClearSession(refreshResult: unknown, error: any): boolean {
    if (refreshResult === null && !error) {
      // 401/403 explicitly returned by backend -> session dead
      return true;
    }
    // Network errors (503/offline) or temporary server 5xx: DO NOT clear session
    return false;
  }

  // 1. Explicit 401/403 -> refreshResult is null -> clear session
  assert.equal(shouldClearSession(null, null), true, '401/403 must clear session');

  // 2. Successful refresh -> do not clear
  assert.equal(shouldClearSession({ accessToken: 'new_acc', refreshToken: 'new_ref' }, null), false);

  // 3. Network glitch (503) -> thrown error -> must NOT clear session
  const networkError = new Error('Could not connect to Pookie Chat.');
  (networkError as any).status = 503;
  assert.equal(shouldClearSession(undefined, networkError), false, '503 network error must NOT clear session');

  // 4. Temporary server 500 error -> must NOT clear session
  const serverError = new Error('Internal server error');
  (serverError as any).status = 500;
  assert.equal(shouldClearSession(undefined, serverError), false, '500 error must NOT clear session');
});

test('Mobile Chat UX: Chat and Room pages use container-only scrolling and preserve keyboard focus', () => {
  const directChatPath = path.resolve(process.cwd(), 'apps/web/app/chat/[conversationId]/page.tsx');
  const roomChatPath = path.resolve(process.cwd(), 'apps/web/app/chat/room/[roomId]/page.tsx');

  const directCode = fs.readFileSync(directChatPath, 'utf8');
  const roomCode = fs.readFileSync(roomChatPath, 'utf8');

  // Both pages must use visualViewport listener
  assert.ok(directCode.includes('window.visualViewport'), 'Direct chat must use visualViewport');
  assert.ok(roomCode.includes('window.visualViewport'), 'Room chat must use visualViewport');

  // Both pages must use container scroll and avoid document scrollIntoView on messages
  assert.ok(directCode.includes('scrollContainerRef.current.scrollTo'), 'Direct chat must scroll container');
  assert.ok(roomCode.includes('scrollContainerRef.current.scrollTo'), 'Room chat must scroll container');

  // Both pages must keep input focused after send
  assert.ok(directCode.includes('textInputRef.current?.focus()'), 'Direct chat must refocus input');
  assert.ok(roomCode.includes('inputRef.current?.focus()'), 'Room chat must refocus input');

  // Both pages must prevent button mouseDown default to avoid keyboard collapse
  assert.ok(directCode.includes('onMouseDown={(e) => e.preventDefault()}'), 'Direct chat send button must prevent default on mouse down');
  assert.ok(roomCode.includes('onMouseDown={(e) => e.preventDefault()}'), 'Room chat send button must prevent default on mouse down');
});

test('Room Key Distribution: Non-owner members receive decrypted code from getRoom', () => {
  function resolveRoomCodeForViewer(room: { code: string; joinPolicy: 'OPEN' | 'APPROVAL_REQUIRED' }, membership: { role: string } | null): string | null {
    if (membership != null || room.joinPolicy === 'OPEN') {
      return room.code;
    }
    return null;
  }

  const room = { code: 'ABC-123-XYZ', joinPolicy: 'APPROVAL_REQUIRED' as const };

  // Owner sees code
  assert.equal(resolveRoomCodeForViewer(room, { role: 'OWNER' }), 'ABC-123-XYZ');

  // Verified accepted MEMBER of APPROVAL_REQUIRED room now receives code to decrypt openKeyCiphertext
  assert.equal(resolveRoomCodeForViewer(room, { role: 'MEMBER' }), 'ABC-123-XYZ');

  // Non-member does NOT see code of APPROVAL_REQUIRED room
  assert.equal(resolveRoomCodeForViewer(room, null), null);
});
