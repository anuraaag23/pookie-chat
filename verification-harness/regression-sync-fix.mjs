// Targeted regression tests for critical fixes found across sessions. Kept
// deliberately small (no browser, no subprocess) after the full
// multi-feature scenario in run-e2e-node.mjs hit an unresolved execution
// issue in an earlier sandbox — this narrower script is what actually
// completed reliably back then (run-e2e-node.mjs has since been confirmed
// to run fine in later sandboxes too, but this file remains the quick,
// targeted place new critical-fix regressions land).
import { createHarness, retryOnUniqueConflict } from './server.mjs';
import * as Engine from '../apps/web/lib/crypto/engine.ts';
import { randomUUID } from 'node:crypto';

const results = [];
function check(label, cond, detail = '') {
  results.push(!!cond);
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${label}${detail ? ' (' + detail + ')' : ''}`);
}

async function run() {
  const { server, db } = createHarness();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = `http://localhost:${port}`;

  async function call(token, method, path, body) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  }

  // --- Register Alice and Bob with real device identities ---
  const aliceIdentity = await Engine.generateDeviceIdentity(3);
  const aliceBundle = Engine.toPublicBundle(aliceIdentity);
  const aliceReg = await call(null, 'POST', '/api/auth/register', {
    password: 'alice-pw-123', username: `harness_alice_${randomUUID().replace(/-/g, '').slice(0, 10)}`, deviceName: 'A', platform: 'web', ...aliceBundle, oneTimePrekeysPublic: aliceIdentity.oneTimePrekeysPublic,
  });
  const alice = aliceReg.data;

  const bobIdentity = await Engine.generateDeviceIdentity(3);
  const bobBundle = Engine.toPublicBundle(bobIdentity);
  const bobReg = await call(null, 'POST', '/api/auth/register', {
    password: 'bob-pw-456', username: `harness_bob_${randomUUID().replace(/-/g, '').slice(0, 10)}`, deviceName: 'B', platform: 'web', ...bobBundle, oneTimePrekeysPublic: bobIdentity.oneTimePrekeysPublic,
  });
  const bob = bobReg.data;
  check('Alice and Bob registered', alice.userId && bob.userId && alice.userId !== bob.userId);

  // --- Pair: Alice creates a code, Bob redeems it (Bob = X3DH initiator) ---
  const pairing = await call(alice.accessToken, 'POST', '/api/pairing/create', { durationSeconds: 900 });
  const redeemed = await call(bob.accessToken, 'POST', '/api/pairing/redeem', { code: pairing.data.code });
  const conversationId = redeemed.data.conversationId;
  const { session: bobSession, message: handshakeMsg } = await Engine.initiateHandshake(bobIdentity, redeemed.data.bundle);
  await call(bob.accessToken, 'POST', '/api/handshake', { conversationId, handshakeMessage: handshakeMsg, sessionEpoch: redeemed.data.sessionEpoch });

  const pending = await call(alice.accessToken, 'GET', `/api/handshake?conversationId=${conversationId}`);
  const { session: aliceSession } = await Engine.completeHandshake(aliceIdentity, pending.data.handshakeMessage);
  check('Both sides derived a working session', !!aliceSession && !!bobSession);

  // --- THE CRITICAL SCENARIO: Bob sends 2 messages while Alice never
  // connects/syncs in between (simulating her being offline), then Alice
  // reconnects and syncs. ---
  let bobSendStep = 0;
  async function bobSend(text, epoch = 1) {
    const aad = Engine.buildAad(conversationId, bobSendStep++);
    const { envelope, nextChainKey } = await Engine.ratchetEncrypt(bobSession.sendingChainKey, text, aad);
    bobSession.sendingChainKey = nextChainKey;
    const clientMessageId = randomUUID();
    return call(bob.accessToken, 'POST', '/api/messages', { conversationId, clientMessageId, ciphertext: envelope.ciphertext, iv: envelope.iv, messageType: 'TEXT', sessionEpoch: epoch });
  }
  const send1 = await bobSend('Hey Alice, are you there?');
  const send2 = await bobSend('Sent while you were offline');
  check('Both sends succeeded, sequential sequence numbers', send1.data.sequenceNumber === 1 && send2.data.sequenceNumber === 2);
  check('Neither was marked delivered (Alice never connected)', send1.data.delivered === false && send2.data.delivered === false);

  // Bob ALSO syncs his own side, at some point — this is exactly the
  // scenario that exposed the bug: does Bob's own sync return his own
  // just-sent messages?
  const bobSync = await call(bob.accessToken, 'GET', `/api/messages/sync?conversationId=${conversationId}&after=0`);
  check(
    "THE FIX: Bob's own sync never returns Bob's own sent messages",
    Array.isArray(bobSync.data) && bobSync.data.length === 0,
    `got ${bobSync.data.length} message(s) back`,
  );

  // Now Alice reconnects and syncs — she SHOULD get both of Bob's messages, in order.
  const aliceSync = await call(alice.accessToken, 'GET', `/api/messages/sync?conversationId=${conversationId}&after=0`);
  check('Alice sync returns exactly Bob\'s 2 messages', aliceSync.data.length === 2);
  check('Every returned message really is from Bob, never from Alice herself', aliceSync.data.every((m) => m.senderId === bob.userId));

  let aliceRecvStep = 0;
  const decrypted = [];
  for (const m of aliceSync.data) {
    const aad = Engine.buildAad(conversationId, aliceRecvStep++);
    const result = await Engine.ratchetDecrypt(aliceSession.receivingChainKey, { ciphertext: m.ciphertext, iv: m.iv }, aad);
    aliceSession.receivingChainKey = result.nextChainKey;
    decrypted.push(result.plaintext);
  }
  check(
    'Both messages decrypt correctly, in the right order, ratchet stayed in sync',
    decrypted[0] === 'Hey Alice, are you there?' && decrypted[1] === 'Sent while you were offline',
    JSON.stringify(decrypted),
  );

  // Confirm the ratchet is genuinely still healthy after all this: one
  // more real message, live this time.
  await bobSend('One more, live this time');
  const followUpSync = await call(alice.accessToken, 'GET', `/api/messages/sync?conversationId=${conversationId}&after=2`);
  const aad3 = Engine.buildAad(conversationId, aliceRecvStep++);
  let result3text;
  try {
    const result3 = await Engine.ratchetDecrypt(aliceSession.receivingChainKey, { ciphertext: followUpSync.data[0].ciphertext, iv: followUpSync.data[0].iv }, aad3);
    result3text = result3.plaintext;
  } catch (e) {
    result3text = `THREW: ${e.message}`;
  }
  check('Ratchet remains healthy for a subsequent message after the fix', result3text === 'One more, live this time', result3text);

  // --- Block: enforced server-side, not just hidden in a UI ---
  await call(alice.accessToken, 'POST', `/api/conversations/${conversationId}/block`, {});
  const blockedSend = await bobSend('can you still see this?');
  check('After Alice blocks, the server rejects Bob\'s further sends', blockedSend.status === 403, `status ${blockedSend.status}`);

  // --- Burn: actually removes server-side ciphertext ---
  await call(alice.accessToken, 'POST', `/api/conversations/${conversationId}/unblock`, {}).catch(() => {});
  // unblock is only callable by whoever blocked — Alice did, so this should succeed:
  const afterUnblock = await bobSend('unblocked now');
  await call(alice.accessToken, 'POST', `/api/conversations/${conversationId}/burn`, {});
  // Updated by the handshake/burn/re-pair hardening pass: sync() now
  // correctly mirrors messages.service.ts's sync(), which has always
  // called getActiveConversationOrThrow before reading anything (a real
  // gap in this harness, found and fixed alongside that work — see
  // server.mjs). A burned conversation is no longer ACTIVE, so sync is
  // now rejected outright (403) rather than silently returning an empty
  // array — a stronger proof that the conversation itself is gone, not
  // merely that it happens to have no rows. The actual row-level
  // deletion (the original point of this check) is verified directly
  // against the database instead, which is more precise than inferring
  // it from an API response shape.
  const postBurnSync = await call(alice.accessToken, 'GET', `/api/messages/sync?conversationId=${conversationId}&after=0`);
  check('Burn: sync on a burned conversation is rejected, not silently emptied', postBurnSync.status === 403, `status ${postBurnSync.status}`);
  const remainingRows = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(conversationId);
  check('Burn actually deletes server-side messages, not just hides them', remainingRows.n === 0, `${remainingRows.n} messages remained`);

  // --- Re-pair after burn: THE SECOND FIX THIS SESSION. Burn sets status
  // DELETED; a re-pairing upsert that reuses the row without resetting
  // status left messaging permanently rejected for this pair, forever. ---
  const secondPairing = await call(alice.accessToken, 'POST', '/api/pairing/create', { durationSeconds: 900 });
  const secondRedeem = await call(bob.accessToken, 'POST', '/api/pairing/redeem', { code: secondPairing.data.code });
  check('Re-pairing after burn reuses the same conversation id', secondRedeem.data.conversationId === conversationId, secondRedeem.data.conversationId);
  const afterRepair = await bobSend('re-paired, are we good now?', secondRedeem.data.sessionEpoch);
  check(
    'THE FIX: messaging works again after burn + re-pair, not permanently rejected',
    afterRepair.status === 201,
    `status ${afterRepair.status}`,
  );

  // --- THE SYNC/REFRESH FIX: the real client (app/chat/[conversationId]/
  // page.tsx) always called sync with a hardcoded after=0 on every mount,
  // so a refresh re-fetched (and attempted to re-decrypt) everything ever
  // received. This simulates the FIXED client's actual algorithm — a
  // persisted, monotonically-advancing lastSyncedSeq used as `after`,
  // exactly matching syncGap() — against the real server and real crypto
  // engine. A fresh pair, so step-counting can't be confused with Alice
  // and Bob's scenario above, which they've already been through a lot by
  // this point (offline catch-up, a live message, block, burn, re-pair). ---
  const carolIdentity = await Engine.generateDeviceIdentity(3);
  const carolBundle = Engine.toPublicBundle(carolIdentity);
  const carol = (await call(null, 'POST', '/api/auth/register', {
    password: 'carol-pw-789', username: `harness_carol_${randomUUID().replace(/-/g, '').slice(0, 10)}`, deviceName: 'C', platform: 'web', ...carolBundle, oneTimePrekeysPublic: carolIdentity.oneTimePrekeysPublic,
  })).data;
  const daveIdentity = await Engine.generateDeviceIdentity(3);
  const daveBundle = Engine.toPublicBundle(daveIdentity);
  const dave = (await call(null, 'POST', '/api/auth/register', {
    password: 'dave-pw-012', username: `harness_dave_${randomUUID().replace(/-/g, '').slice(0, 10)}`, deviceName: 'D', platform: 'web', ...daveBundle, oneTimePrekeysPublic: daveIdentity.oneTimePrekeysPublic,
  })).data;
  const cdPairing = await call(carol.accessToken, 'POST', '/api/pairing/create', { durationSeconds: 900 });
  const cdRedeemed = await call(dave.accessToken, 'POST', '/api/pairing/redeem', { code: cdPairing.data.code });
  const cdConversationId = cdRedeemed.data.conversationId;
  const { session: daveSession, message: cdHandshakeMsg } = await Engine.initiateHandshake(daveIdentity, cdRedeemed.data.bundle);
  await call(dave.accessToken, 'POST', '/api/handshake', { conversationId: cdConversationId, handshakeMessage: cdHandshakeMsg, sessionEpoch: cdRedeemed.data.sessionEpoch });
  const cdPending = await call(carol.accessToken, 'GET', `/api/handshake?conversationId=${cdConversationId}`);
  const { session: carolSession } = await Engine.completeHandshake(carolIdentity, cdPending.data.handshakeMessage);

  let carolLastSyncedSeq = 0; // mirrors StoredSession.lastSyncedSeq, persisted across "bootstraps" below
  let carolRecvStep = 0;
  async function carolSyncAndDecrypt() {
    const gap = await call(carol.accessToken, 'GET', `/api/messages/sync?conversationId=${cdConversationId}&after=${carolLastSyncedSeq}`);
    const decryptedNow = [];
    for (const m of gap.data) {
      const aad = Engine.buildAad(cdConversationId, carolRecvStep);
      try {
        const result = await Engine.ratchetDecrypt(carolSession.receivingChainKey, { ciphertext: m.ciphertext, iv: m.iv }, aad);
        carolSession.receivingChainKey = result.nextChainKey;
        carolRecvStep += 1;
        decryptedNow.push(result.plaintext);
      } catch (e) {
        decryptedNow.push(`FAILED: ${e.message}`);
      }
      carolLastSyncedSeq = Math.max(carolLastSyncedSeq, m.sequenceNumber); // same Math.max guard as processIncoming()
    }
    return { gapCount: gap.data.length, decryptedNow };
  }
  let daveSendStep = 0;
  async function daveSend(text) {
    const aad = Engine.buildAad(cdConversationId, daveSendStep++);
    const { envelope, nextChainKey } = await Engine.ratchetEncrypt(daveSession.sendingChainKey, text, aad);
    daveSession.sendingChainKey = nextChainKey;
    const clientMessageId = randomUUID();
    return call(dave.accessToken, 'POST', '/api/messages', { conversationId: cdConversationId, clientMessageId, ciphertext: envelope.ciphertext, iv: envelope.iv, messageType: 'TEXT', sessionEpoch: 1 });
  }

  await daveSend('one');
  await daveSend('two');
  await daveSend('three');
  const firstSync = await carolSyncAndDecrypt();
  check(
    'Sync scenario: first bootstrap gets exactly 3 messages, all decrypt correctly',
    firstSync.gapCount === 3 && JSON.stringify(firstSync.decryptedNow) === JSON.stringify(['one', 'two', 'three']),
    JSON.stringify(firstSync),
  );

  // "Carol refreshes" — bootstrap runs again, using the PERSISTED
  // lastSyncedSeq (3), exactly like the fixed client does.
  const refreshSync = await carolSyncAndDecrypt();
  check('THE FIX: refresh re-fetches zero messages, attempts zero re-decrypts', refreshSync.gapCount === 0, `got ${refreshSync.gapCount} back`);

  // Dave sends 2 more while "Carol is offline" (simulated by simply not
  // calling sync in between).
  await daveSend('four');
  await daveSend('five');

  // "Carol reconnects."
  const reconnectSync = await carolSyncAndDecrypt();
  check(
    'THE FIX: reconnect fetches exactly the 2 new messages, not all 5',
    reconnectSync.gapCount === 2 && JSON.stringify(reconnectSync.decryptedNow) === JSON.stringify(['four', 'five']),
    JSON.stringify(reconnectSync),
  );
  check('Ratchet remains synchronized: recvStep is exactly 5 after 5 total messages', carolRecvStep === 5, `recvStep=${carolRecvStep}`);

  // Regression guard: prove the bug this fixes was real, on the real
  // server — the old hardcoded after=0 really would re-return everything.
  const staleSync = await call(carol.accessToken, 'GET', `/api/messages/sync?conversationId=${cdConversationId}&after=0`);
  check(
    'Confirms the bug was real: after=0 (the old hardcoded call) re-returns all 5, not just new ones',
    staleSync.data.length === 5,
    `got ${staleSync.data.length} back — this is what the old client did on every single bootstrap`,
  );

  // --- THE EDIT-WHILE-OFFLINE FIX: an edit to an already-synced message
  // wasn't picked up by sync at all, since the edited row kept its
  // original sequenceNumber. Reuses Carol/Dave's session above — Carol is
  // caught up through 5 messages, recvStep=5. ---
  const carolTexts = ['one', 'two', 'three', 'four', 'five'];
  const firstFiveIds = (await call(carol.accessToken, 'GET', `/api/messages/sync?conversationId=${cdConversationId}&after=0`)).data.map((m) => m.id);
  const carolCache = new Map(firstFiveIds.map((id, i) => [id, carolTexts[i]]));

  const editAad = Engine.buildAad(cdConversationId, daveSendStep++);
  const editResult = await Engine.ratchetEncrypt(daveSession.sendingChainKey, 'one (edited while Carol was offline)', editAad);
  daveSession.sendingChainKey = editResult.nextChainKey;
  const editedId = firstFiveIds[0];
  await call(dave.accessToken, 'PATCH', `/api/messages/${editedId}`, { ciphertext: editResult.envelope.ciphertext, iv: editResult.envelope.iv });

  const editSync = await carolSyncAndDecrypt();
  check('THE FIX: reconnect after an offline edit fetches exactly that 1 item, not the other 4 again', editSync.gapCount === 1, `got ${editSync.gapCount} back`);
  check(
    'THE FIX: the edited message decrypts to the new text',
    editSync.decryptedNow[0] === 'one (edited while Carol was offline)',
    JSON.stringify(editSync.decryptedNow),
  );
  // Mirrors processIncoming's append-vs-update logic: this id was already
  // in Carol's cache, so it must be an in-place update, not a 6th entry.
  if (carolCache.has(editedId)) carolCache.set(editedId, editSync.decryptedNow[0]);
  check('No duplicate cache entry: still exactly 5 cached messages, not 6', carolCache.size === 5, `cache has ${carolCache.size} entries`);
  check('Ratchet remains synchronized after the edit: recvStep is exactly 6', carolRecvStep === 6, `recvStep=${carolRecvStep}`);

  const afterEditRefreshSync = await carolSyncAndDecrypt();
  check('A further refresh after the edit re-fetches zero, including the edit itself', afterEditRefreshSync.gapCount === 0, `got ${afterEditRefreshSync.gapCount} back`);

  // --- WEBSOCKET RATE LIMITING: neither handleConnection nor onTyping had
  // any limit at all before this session — both only require a valid
  // access token to reach. Opens real WebSocket connections against the
  // real (harness) server to prove the caps actually reject/drop, not
  // just that the code compiles. ---
  function openWs(token) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}?token=${encodeURIComponent(token)}`);
      let closed = false;
      ws.addEventListener('close', () => {
        closed = true;
      });
      ws.addEventListener('open', () => {
        // The protocol-level handshake can complete (firing 'open') before
        // the server's application code decides to reject and disconnect
        // — same as the pre-existing auth-failure path, which uses this
        // identical accept-then-disconnect pattern. A short grace period
        // distinguishes "genuinely open" from "opened, then rejected".
        setTimeout(() => resolve(closed ? null : ws), 50);
      });
      ws.addEventListener('error', reject);
    });
  }
  const carolSockets = [];
  for (let i = 0; i < 8; i++) carolSockets.push(await openWs(carol.accessToken));
  check('Connection cap: the first 8 connections for one user all succeed', carolSockets.every((s) => s !== null), `${carolSockets.filter((s) => s).length}/8 opened`);
  const ninthSocket = await openWs(carol.accessToken);
  check('THE FIX: the 9th simultaneous connection for the same user is rejected', ninthSocket === null, ninthSocket ? 'connection opened instead of being rejected' : 'rejected as expected');

  const daveSocket = await openWs(dave.accessToken);
  const daveTypingEvents = [];
  daveSocket.addEventListener('message', (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === 'typing') daveTypingEvents.push(msg);
  });
  const carolTypingSocket = carolSockets[0];
  for (let i = 0; i < 35; i++) {
    carolTypingSocket.send(JSON.stringify({ type: 'typing', conversationId: cdConversationId, isTyping: true }));
  }
  await new Promise((r) => setTimeout(r, 300)); // let the relayed events actually arrive
  check(
    'THE FIX: 35 rapid typing events are capped at 30 relayed, not all 35',
    daveTypingEvents.length > 0 && daveTypingEvents.length <= 30,
    `dave received ${daveTypingEvents.length}`,
  );

  for (const s of carolSockets) s?.close();
  daveSocket.close();

  // ============================================================
  // retryOnUniqueConflict — the actual retry control flow used by both
  // send() and edit() in server.mjs, tested directly here (not
  // reimplemented) against a fake conflicting write. This is what proves
  // the retry *logic* is correct — retries the right number of times,
  // gives up correctly, never swallows an unrelated error — independent
  // of the fact that node:sqlite's synchronous execution model can't
  // reproduce a *genuine* concurrent collision the way real concurrent
  // Postgres connections could (see the "Sequence hardening" block
  // below for that scope note in full).
  // ============================================================
  {
    const conflictErr = () => Object.assign(new Error('UNIQUE constraint failed: messages.conversation_id, messages.sync_version'), { errcode: 2067 });

    let calls = 0;
    const succeedsOnThirdTry = await retryOnUniqueConflict(() => {
      calls += 1;
      if (calls < 3) throw conflictErr();
      return 'ok';
    }, 5);
    check('retryOnUniqueConflict: recovers after 2 conflicts, succeeding on the 3rd attempt', succeedsOnThirdTry === 'ok' && calls === 3, `calls=${calls}`);

    let exhaustedCalls = 0;
    let exhaustedThrew = false;
    try {
      await retryOnUniqueConflict(() => {
        exhaustedCalls += 1;
        throw conflictErr();
      }, 3);
    } catch {
      exhaustedThrew = true;
    }
    check('retryOnUniqueConflict: gives up after maxAttempts, not an infinite loop', exhaustedThrew && exhaustedCalls === 3, `calls=${exhaustedCalls}`);

    let unrelatedCalls = 0;
    let unrelatedErrorPropagated = false;
    try {
      await retryOnUniqueConflict(() => {
        unrelatedCalls += 1;
        throw new Error('something else entirely — not a constraint violation');
      }, 5);
    } catch (e) {
      unrelatedErrorPropagated = e.message.includes('something else entirely');
    }
    check(
      'retryOnUniqueConflict: an unrelated error is never retried — propagates on the first attempt',
      unrelatedErrorPropagated && unrelatedCalls === 1,
      `calls=${unrelatedCalls}`,
    );
  }

  // ============================================================
  // Sequence-number / syncVersion race hardening (messages.service.ts's
  // createMessageWithRetry / editMessage retry loops).
  //
  // IMPORTANT SCOPE NOTE: node:sqlite's DatabaseSync runs every statement
  // in this harness synchronously with no `await` between a MAX(...)
  // read and the following INSERT/UPDATE — unlike real concurrent
  // Postgres connections, two "concurrent" requests to this harness
  // cannot actually interleave between those two statements, so a
  // *genuine* collision cannot be produced through this harness no
  // matter how the retry logic itself is structured (verified directly,
  // above, instead). What CAN be honestly verified without a real
  // Postgres: the new @@unique([conversationId, syncVersion]) constraint
  // that makes a collision detectable at all actually exists and is
  // enforced, and that ordinary sequential sends/edits (the 99.9% case)
  // are unaffected by having added it.
  // ============================================================
  {
    const erinIdentity = await Engine.generateDeviceIdentity(3);
    const erinBundle = Engine.toPublicBundle(erinIdentity);
    const erin = (
      await call(null, 'POST', '/api/auth/register', { password: 'erin-pw', username: `harness_erin_${randomUUID().replace(/-/g, '').slice(0, 10)}`, deviceName: 'erin-device', platform: 'web', ...erinBundle, oneTimePrekeysPublic: erinIdentity.oneTimePrekeysPublic })
    ).data;
    const frankIdentity = await Engine.generateDeviceIdentity(3);
    const frankBundle = Engine.toPublicBundle(frankIdentity);
    const frank2 = (
      await call(null, 'POST', '/api/auth/register', { password: 'frank-pw', username: `harness_frank_${randomUUID().replace(/-/g, '').slice(0, 10)}`, deviceName: 'frank2-device', platform: 'web', ...frankBundle, oneTimePrekeysPublic: frankIdentity.oneTimePrekeysPublic })
    ).data;
    const pairing = await call(erin.accessToken, 'POST', '/api/pairing/create', { durationSeconds: 900 });
    const redeemed = await call(frank2.accessToken, 'POST', '/api/pairing/redeem', { code: pairing.data.code });
    const conversationId = redeemed.data.conversationId;

    // Schema-level check: the constraint that turns a collision into a
    // catchable, retryable error (rather than silent duplicate data)
    // actually exists and rejects a direct duplicate.
    const seedId = randomUUID();
    db.prepare(
      `INSERT INTO messages (id, conversation_id, sender_id, sequence_number, sync_version, client_message_id, ciphertext, iv, message_type, sent_at)
       VALUES (?, ?, ?, 501, 501, 'seed-1', 'x', 'y', 'TEXT', ?)`,
    ).run(seedId, conversationId, erin.userId, new Date().toISOString());
    let rejected = false;
    try {
      db.prepare(
        `INSERT INTO messages (id, conversation_id, sender_id, sequence_number, sync_version, client_message_id, ciphertext, iv, message_type, sent_at)
         VALUES (?, ?, ?, 502, 501, 'seed-2', 'x', 'y', 'TEXT', ?)`,
      ).run(randomUUID(), conversationId, erin.userId, new Date().toISOString());
    } catch (err) {
      // node:sqlite reports this via err.errcode (2067 =
      // SQLITE_CONSTRAINT_UNIQUE), not err.code — see server.mjs's
      // isSqliteUniqueConstraintError for why.
      rejected = err?.errcode === 2067 || String(err?.message || '').includes('UNIQUE constraint failed');
    }
    check('Sequence hardening: UNIQUE(conversationId, syncVersion) exists and rejects a duplicate', rejected);
    db.prepare('DELETE FROM messages WHERE id = ?').run(seedId); // clean up the raw seed row before real traffic in this conversation

    // Happy-path regression: ordinary sequential sends still get correct,
    // increasing sequence numbers with the new constraint in place.
    const { session, message: handshakeMessage } = await Engine.initiateHandshake(frankIdentity, redeemed.data.bundle);
    await call(frank2.accessToken, 'POST', '/api/handshake', { conversationId, handshakeMessage, sessionEpoch: redeemed.data.sessionEpoch });
    let step = 0;
    async function sendAsFrank(text) {
      const aad = Engine.buildAad(conversationId, step);
      const { envelope, nextChainKey } = await Engine.ratchetEncrypt(session.sendingChainKey, text, aad);
      session.sendingChainKey = nextChainKey;
      step += 1;
      return call(frank2.accessToken, 'POST', '/api/messages', {
        conversationId,
        clientMessageId: randomUUID(),
        ciphertext: envelope.ciphertext,
        iv: envelope.iv,
        messageType: 'TEXT',
        sessionEpoch: redeemed.data.sessionEpoch,
      });
    }
    const s1 = await sendAsFrank('one');
    const s2 = await sendAsFrank('two');
    const s3 = await sendAsFrank('three');
    check(
      'Sequence hardening: ordinary sequential sends still get strictly increasing sequence numbers',
      s1.status === 201 && s2.status === 201 && s3.status === 201 && s2.data.sequenceNumber > s1.data.sequenceNumber && s3.data.sequenceNumber > s2.data.sequenceNumber,
      `${s1.status}/${s2.status}/${s3.status}, seqs ${s1.data.sequenceNumber},${s2.data.sequenceNumber},${s3.data.sequenceNumber}`,
    );

    // Happy-path regression: editing still works and correctly advances
    // past both counters with the new constraint in place.
    const editResult = await call(frank2.accessToken, 'PATCH', `/api/messages/${s1.data.id}`, { ciphertext: 'edited-cipher', iv: 'edited-iv' });
    check('Sequence hardening: editing a message still succeeds with the new syncVersion constraint in place', editResult.status === 200, `got ${editResult.status}`);
    const s4 = await sendAsFrank('four');
    check(
      "Sequence hardening: a send after an edit still gets a sequence number ahead of the edit's bumped syncVersion (higherCounterValue reconciliation unaffected)",
      s4.status === 201 && s4.data.sequenceNumber > s1.data.sequenceNumber,
      `got seq ${s4.data.sequenceNumber} vs edited-message seq ${s1.data.sequenceNumber}`,
    );
  }

  // ============================================================
  // Deletion sync propagation to an offline recipient — THE FIX.
  // deleteMessage() previously never bumped syncVersion, so a recipient
  // who had already synced past a message's original position would
  // never see it again in any future sync — meaning a deletion that
  // happened while they were offline would never reach them at all,
  // and the message would stay in their local cache forever.
  // ============================================================
  {
    const erinIdentity = await Engine.generateDeviceIdentity(3);
    const erinBundle = Engine.toPublicBundle(erinIdentity);
    const erin = (
      await call(null, 'POST', '/api/auth/register', { password: 'pw', username: `harness_erin2_${randomUUID().replace(/-/g, '').slice(0, 10)}`, deviceName: 'erin2-' + randomUUID(), platform: 'web', ...erinBundle, oneTimePrekeysPublic: erinIdentity.oneTimePrekeysPublic })
    ).data;
    const frankIdentity = await Engine.generateDeviceIdentity(3);
    const frankBundle = Engine.toPublicBundle(frankIdentity);
    const frank3 = (
      await call(null, 'POST', '/api/auth/register', { password: 'pw', username: `harness_frank3_${randomUUID().replace(/-/g, '').slice(0, 10)}`, deviceName: 'frank3-' + randomUUID(), platform: 'web', ...frankBundle, oneTimePrekeysPublic: frankIdentity.oneTimePrekeysPublic })
    ).data;
    const p = await call(erin.accessToken, 'POST', '/api/pairing/create', { durationSeconds: 900 });
    const r = await call(frank3.accessToken, 'POST', '/api/pairing/redeem', { code: p.data.code });
    const conversationId = r.data.conversationId;
    const initiated = await Engine.initiateHandshake(frankIdentity, r.data.bundle);
    await call(frank3.accessToken, 'POST', '/api/handshake', { conversationId, handshakeMessage: initiated.message, sessionEpoch: r.data.sessionEpoch });

    // Frank (the redeemer, who initiated the handshake) sends to Erin.
    const aad = Engine.buildAad(conversationId, 0);
    const { envelope } = await Engine.ratchetEncrypt(initiated.session.sendingChainKey, 'delete me later', aad);
    const sent = await call(frank3.accessToken, 'POST', '/api/messages', {
      conversationId,
      clientMessageId: randomUUID(),
      ciphertext: envelope.ciphertext,
      iv: envelope.iv,
      messageType: 'TEXT',
      sessionEpoch: r.data.sessionEpoch,
    });

    // Erin syncs and receives it — she now has it cached, exactly like a
    // real client would.
    const firstSync = await call(erin.accessToken, 'GET', `/api/messages/sync?conversationId=${conversationId}&after=0`);
    check('Deletion sync setup: Erin receives the message on her first sync', firstSync.data.length === 1 && firstSync.data[0].deleted === false);
    const lastSyncedSeq = firstSync.data[0].sequenceNumber;

    // Erin goes offline (no WS connection at all in this test). Frank
    // deletes the message while she's not watching.
    const del = await call(frank3.accessToken, 'DELETE', `/api/messages/${sent.data.id}`, {});
    check('Deletion sync setup: delete succeeds', del.status === 200);

    // Erin "reconnects" and syncs again from where she left off.
    const secondSync = await call(erin.accessToken, 'GET', `/api/messages/sync?conversationId=${conversationId}&after=${lastSyncedSeq}`);
    check(
      'Deletion sync — THE FIX: an offline recipient learns about a deletion on their next sync, not only via the live push they missed',
      secondSync.data.length === 1 && secondSync.data[0].id === sent.data.id && secondSync.data[0].deleted === true,
      `got ${JSON.stringify(secondSync.data)}`,
    );
    check('Deletion sync: the tombstone carries no leftover ciphertext', secondSync.data[0].ciphertext === '');
  }

  // ============================================================
  // Attachment cleanup on message delete/expiry — THE FIX. Deleting a
  // message previously only wiped its own ciphertext; a linked
  // attachment's row (and the still-downloadable file it points to)
  // was never touched at all, since onDelete: Cascade never fires for
  // a soft delete. Verified here at the DB-wiring level — actual
  // Drive upload/download has never been testable in this sandbox (no
  // credentials), so this seeds a linked attachment row directly
  // rather than going through a real upload.
  // ============================================================
  {
    const graceIdentity = await Engine.generateDeviceIdentity(3);
    const graceBundle = Engine.toPublicBundle(graceIdentity);
    const grace = (
      await call(null, 'POST', '/api/auth/register', { password: 'pw', username: `harness_grace_${randomUUID().replace(/-/g, '').slice(0, 10)}`, deviceName: 'grace-' + randomUUID(), platform: 'web', ...graceBundle, oneTimePrekeysPublic: graceIdentity.oneTimePrekeysPublic })
    ).data;
    const heidiIdentity = await Engine.generateDeviceIdentity(3);
    const heidiBundle = Engine.toPublicBundle(heidiIdentity);
    const heidi = (
      await call(null, 'POST', '/api/auth/register', { password: 'pw', username: `harness_heidi_${randomUUID().replace(/-/g, '').slice(0, 10)}`, deviceName: 'heidi-' + randomUUID(), platform: 'web', ...heidiBundle, oneTimePrekeysPublic: heidiIdentity.oneTimePrekeysPublic })
    ).data;
    const p = await call(grace.accessToken, 'POST', '/api/pairing/create', { durationSeconds: 900 });
    const r = await call(heidi.accessToken, 'POST', '/api/pairing/redeem', { code: p.data.code });
    const conversationId = r.data.conversationId;
    const initiated = await Engine.initiateHandshake(heidiIdentity, r.data.bundle);
    await call(heidi.accessToken, 'POST', '/api/handshake', { conversationId, handshakeMessage: initiated.message, sessionEpoch: r.data.sessionEpoch });
    const aad = Engine.buildAad(conversationId, 0);
    const { envelope } = await Engine.ratchetEncrypt(initiated.session.sendingChainKey, 'photo attached', aad);
    const sent = await call(heidi.accessToken, 'POST', '/api/messages', {
      conversationId,
      clientMessageId: randomUUID(),
      ciphertext: envelope.ciphertext,
      iv: envelope.iv,
      messageType: 'IMAGE',
      sessionEpoch: r.data.sessionEpoch,
    });
    const attachmentId = randomUUID();
    db.prepare('INSERT INTO attachments (id, message_id, conversation_id, drive_file_id) VALUES (?, ?, ?, ?)').run(
      attachmentId,
      sent.data.id,
      conversationId,
      'fake-drive-file-id',
    );
    check('Attachment cleanup setup: the attachment is linked and present', !!db.prepare('SELECT 1 FROM attachments WHERE id = ?').get(attachmentId));

    await call(heidi.accessToken, 'DELETE', `/api/messages/${sent.data.id}`, {});
    check(
      "Attachment cleanup — THE FIX: deleting the message also removes its linked attachment, not just the message's own text",
      !db.prepare('SELECT 1 FROM attachments WHERE id = ?').get(attachmentId),
    );
  }

  server.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checks passed.`);
  process.exit(passed === results.length ? 0 : 1);
}

run().catch((e) => {
  console.error('CRASHED:', e);
  process.exit(1);
});
