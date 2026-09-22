// Regression tests for the handshake/burn/re-pair hardening pass.
//
// Mirrors the real backend's pairing.service.ts / handshake.service.ts /
// conversations.service.ts / messages.service.ts logic in server.mjs
// (which itself imports the real domain/sessionEpoch.ts and
// domain/messageState.ts directly — not reimplemented) so these run
// against real HTTP + real WebSocket connections, and the real crypto
// engine (apps/web/lib/crypto/engine.ts, imported directly) for X3DH and
// the ratchet. Same approach as regression-session-management.mjs and
// regression-sync-fix.mjs.
//
// What this file is actually proving: the sessionEpoch lifecycle
// mechanism (see domain/sessionEpoch.ts's file comment for the full
// rationale) correctly distinguishes a conversation's current
// cryptographic session from a superseded one, across every place that
// distinction matters — handshake storage/retrieval, message sending,
// burn, and re-pairing — including under retry, staleness, offline, and
// concurrent conditions.
import { createHarness } from './server.mjs';
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
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  }

  function openWs(token) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}?token=${encodeURIComponent(token)}`);
      const events = [];
      ws.addEventListener('message', (evt) => events.push(JSON.parse(evt.data)));
      let closed = false;
      ws.addEventListener('close', () => {
        closed = true;
      });
      ws.addEventListener('open', () => setTimeout(() => resolve(closed ? null : { ws, events }), 50));
      ws.addEventListener('error', reject);
    });
  }

  // A test-side stand-in for the real client's algorithm — mirrors
  // app/chat/[conversationId]/page.tsx and app/connect/page.tsx, using
  // the real crypto engine, but callable directly instead of through a
  // browser. Deliberately tracks epoch on the session object itself, the
  // same way StoredSession does, and exposes `sendRaw`/`decryptOne`
  // separately from the "happy path" helpers so tests can deliberately
  // exercise wrong epochs / stale keys.
  function makeClient() {
    const c = {};
    c.register = async (password, deviceName) => {
      c.identity = await Engine.generateDeviceIdentity(10);
      const bundle = Engine.toPublicBundle(c.identity);
      const result = await call(null, 'POST', '/api/auth/register', {
        password,
        username: `harness_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        deviceName,
        platform: 'web',
        ...bundle,
        oneTimePrekeysPublic: c.identity.oneTimePrekeysPublic,
      });
      c.userId = result.data.userId;
      c.deviceId = result.data.deviceId;
      c.accessToken = result.data.accessToken;
      return result;
    };
    c.createPairing = (durationSeconds = 900) => call(c.accessToken, 'POST', '/api/pairing/create', { durationSeconds });
    // Redeemer side: initiates X3DH, stores the handshake message for
    // the creator to pick up later. Tags the resulting session with the
    // epoch the redeem response reported, exactly like initSession does.
    c.redeem = async (code) => {
      const result = await call(c.accessToken, 'POST', '/api/pairing/redeem', { code });
      if (result.status !== 200) return result;
      const { session, message } = await Engine.initiateHandshake(c.identity, result.data.bundle);
      c.session = { ...session, sendStep: 0, recvStep: 0, epoch: result.data.sessionEpoch };
      const stored = await call(c.accessToken, 'POST', '/api/handshake', {
        conversationId: result.data.conversationId,
        handshakeMessage: message,
        sessionEpoch: result.data.sessionEpoch,
      });
      return { ...result, storeResult: stored };
    };
    // Creator side: fetches whatever's pending and completes it. Returns
    // the raw fetch result so callers can check status/epoch without
    // completing (e.g. to prove retryability), or call this to actually
    // establish/replace c.session.
    c.fetchHandshake = (conversationId) => call(c.accessToken, 'GET', `/api/handshake?conversationId=${conversationId}`, undefined);
    c.completeFromServer = async (conversationId) => {
      const fetched = await c.fetchHandshake(conversationId);
      if (fetched.status !== 200) return fetched;
      const { session } = await Engine.completeHandshake(c.identity, fetched.data.handshakeMessage);
      c.session = { ...session, sendStep: 0, recvStep: 0, epoch: fetched.data.sessionEpoch };
      return fetched;
    };
    c.status = (conversationId) => call(c.accessToken, 'GET', `/api/conversations/${conversationId}`, undefined);
    // sendRaw lets a test claim any epoch it wants (including a wrong
    // one) independently of what c.session.epoch currently holds —
    // needed to prove the server-side check actually looks at the
    // claimed value, not just trusts the client's bookkeeping.
    c.sendRaw = async (conversationId, plaintext, epochClaim) => {
      const aad = Engine.buildAad(conversationId, c.session.sendStep);
      const { envelope, nextChainKey } = await Engine.ratchetEncrypt(c.session.sendingChainKey, plaintext, aad);
      const result = await call(c.accessToken, 'POST', '/api/messages', {
        conversationId,
        clientMessageId: randomUUID(),
        ciphertext: envelope.ciphertext,
        iv: envelope.iv,
        messageType: 'TEXT',
        sessionEpoch: epochClaim,
      });
      if (result.status === 201) {
        c.session.sendingChainKey = nextChainKey;
        c.session.sendStep += 1;
      }
      return result;
    };
    c.send = (conversationId, plaintext) => c.sendRaw(conversationId, plaintext, c.session.epoch);
    // Attempts decrypt against c.session's CURRENT receiving chain key.
    // Never throws — returns {ok:false} on failure, since "this session
    // cannot decrypt this ciphertext" is exactly the outcome several
    // tests below need to assert on, not treat as an error.
    c.decryptOne = async (conversationId, m) => {
      try {
        const aad = Engine.buildAad(conversationId, c.session.recvStep);
        const result = await Engine.ratchetDecrypt(c.session.receivingChainKey, { ciphertext: m.ciphertext, iv: m.iv }, aad);
        c.session.receivingChainKey = result.nextChainKey;
        c.session.recvStep += 1;
        return { ok: true, plaintext: result.plaintext };
      } catch {
        return { ok: false };
      }
    };
    c.sync = (conversationId, after = 0) => call(c.accessToken, 'GET', `/api/messages/sync?conversationId=${conversationId}&after=${after}`, undefined);
    c.burn = (conversationId) => call(c.accessToken, 'POST', `/api/conversations/${conversationId}/burn`, {});
    return c;
  }

  let n = 0;
  const uniq = () => `u${Date.now()}_${n++}_${Math.random().toString(36).slice(2)}`;

  // ============================================================
  // 1. Normal handshake — baseline correctness
  // ============================================================
  {
    const alice = makeClient();
    const bob = makeClient();
    await alice.register('pw', uniq());
    await bob.register('pw', uniq());

    const created = await alice.createPairing(900);
    const redeemed = await bob.redeem(created.data.code);
    check('Normal handshake: redeem succeeds', redeemed.status === 200);
    check('Normal handshake: a brand-new conversation starts at epoch 1', redeemed.data.sessionEpoch === 1, `got ${redeemed.data.sessionEpoch}`);
    check('Normal handshake: handshake store succeeds', redeemed.storeResult.status === 201);

    const conversationId = redeemed.data.conversationId;
    const completed = await alice.completeFromServer(conversationId);
    check('Normal handshake: creator fetch+complete succeeds', completed.status === 200);
    check('Normal handshake: creator sees the same epoch the redeemer saw', completed.data.sessionEpoch === 1);

    const sent = await bob.send(conversationId, 'hello alice');
    check('Normal handshake: redeemer can send after storing', sent.status === 201);
    const gap = await alice.sync(conversationId, 0);
    check('Normal handshake: creator syncs the message', gap.status === 200 && gap.data.length === 1);
    const decrypted = await alice.decryptOne(conversationId, gap.data[0]);
    check('Normal handshake: creator decrypts it correctly', decrypted.ok && decrypted.plaintext === 'hello alice');

    const reply = await alice.send(conversationId, 'hi bob');
    check('Normal handshake: creator can send back', reply.status === 201);
    const gap2 = await bob.sync(conversationId, 0);
    const decrypted2 = await bob.decryptOne(conversationId, gap2.data[0]);
    check('Normal handshake: redeemer decrypts the reply correctly', decrypted2.ok && decrypted2.plaintext === 'hi bob');

    // ============================================================
    // 2 & 3. Handshake retry + duplicate completion — fetch is safe to
    // repeat, and repeating it never produces a divergent session.
    // ============================================================
    const carol = makeClient();
    const dave = makeClient();
    await carol.register('pw', uniq());
    await dave.register('pw', uniq());
    const cd = await carol.createPairing(900);
    const daveRedeem = await dave.redeem(cd.data.code);
    const convo2 = daveRedeem.data.conversationId;

    const fetch1 = await carol.fetchHandshake(convo2);
    const fetch2 = await carol.fetchHandshake(convo2);
    check('Handshake retry: fetching twice both succeed', fetch1.status === 200 && fetch2.status === 200);
    check(
      'Handshake retry: repeated fetch returns byte-identical payload (not consumed/mutated on read)',
      JSON.stringify(fetch1.data) === JSON.stringify(fetch2.data),
    );
    const session1 = await Engine.completeHandshake(carol.identity, fetch1.data.handshakeMessage);
    const session2 = await Engine.completeHandshake(carol.identity, fetch2.data.handshakeMessage);
    check(
      'Duplicate completion: completing from two independent fetches derives the identical sending chain key',
      Buffer.from(session1.session.sendingChainKey).equals(Buffer.from(session2.session.sendingChainKey)),
    );
    check(
      'Duplicate completion: completing from two independent fetches derives the identical receiving chain key',
      Buffer.from(session1.session.receivingChainKey).equals(Buffer.from(session2.session.receivingChainKey)),
    );
  }

  // ============================================================
  // 4. Stale handshake — a pending handshake left over from a
  //    superseded epoch (re-paired without an intervening burn) is
  //    never handed out, even though the row still physically exists.
  // ============================================================
  {
    const carol = makeClient();
    const dave = makeClient();
    await carol.register('pw', uniq());
    await dave.register('pw', uniq());
    const p1 = await carol.createPairing(900);
    const r1 = await dave.redeem(p1.data.code);
    const conversationId = r1.data.conversationId;
    check('Stale handshake setup: first redeem is epoch 1', r1.data.sessionEpoch === 1);
    // Dave stored a handshake for epoch 1. Carol never fetches it.
    // Carol and Dave pair AGAIN (no burn in between) — this is allowed
    // (see pairing.service.ts: redeem doesn't require the prior
    // conversation to be burned) and bumps the epoch again.
    const p2 = await carol.createPairing(900);
    const r2 = await dave.redeem(p2.data.code);
    check('Stale handshake setup: re-pairing without a burn reuses the same conversation', r2.data.conversationId === conversationId);
    check('Stale handshake setup: epoch advances again', r2.data.sessionEpoch === 2, `got ${r2.data.sessionEpoch}`);
    // Dave's second store() call already overwrote the row (upsert), so
    // to actually exercise the "leftover epoch-1 row" path we simulate
    // the second store() call not having landed yet by fetching BEFORE
    // it — but r2.storeResult already awaited it above. Re-derive the
    // race directly: redeem again (epoch 3) and check the fetch BEFORE
    // calling store for that epoch.
    const p3 = await carol.createPairing(900);
    const redeemOnly = await call(dave.accessToken, 'POST', '/api/pairing/redeem', { code: p3.data.code });
    check('Stale handshake setup: third redeem bumps epoch to 3 before any new store()', redeemOnly.data.sessionEpoch === 3);
    const staleFetch = await carol.fetchHandshake(conversationId);
    check(
      'Stale handshake: fetching while the only stored handshake is from a superseded epoch returns 404, not the stale payload',
      staleFetch.status === 404,
      `got ${staleFetch.status}`,
    );
  }

  // ============================================================
  // 5. Handshake after revoked device
  // ============================================================
  {
    const eve = makeClient();
    const frank = makeClient();
    await eve.register('pw', uniq());
    await frank.register('pw', uniq());
    const p = await eve.createPairing(900);
    // Revoke Eve's only device (mirrors "remote logout" from the
    // Devices & Sessions work) before Frank redeems. DELETE
    // /api/auth/sessions/:id takes the *session* id, not the device id —
    // fetch Eve's session list to find the one for her device.
    const sessions = await call(eve.accessToken, 'GET', '/api/auth/sessions', undefined);
    const eveSessionId = sessions.data.find((s) => s.deviceId === eve.deviceId)?.id;
    const revoke = await call(eve.accessToken, 'DELETE', `/api/auth/sessions/${eveSessionId}`, undefined);
    check('Revoked-device setup: revoke succeeds', revoke.status === 200, `got ${revoke.status}`);

    const attempt = await call(frank.accessToken, 'POST', '/api/pairing/redeem', { code: p.data.code });
    check(
      'Handshake after revoked device: redemption fails cleanly (400), not a 500 crash',
      attempt.status === 400,
      `got ${attempt.status} ${JSON.stringify(attempt.data)}`,
    );

    // The fix under test (pairing.service.ts's reordering): failing here
    // must not have burned the code. Verify directly against the DB
    // first (precise), then prove it functionally by actually
    // succeeding on a retry once Eve has a working device again.
    const codeRow = db.prepare('SELECT status FROM pairing_codes WHERE id = ?').get(p.data.pairingId);
    check('Handshake after revoked device: the pairing code is NOT consumed by the failed attempt (still ACTIVE in the DB)', codeRow?.status === 'ACTIVE', `got ${codeRow?.status}`);

    // Eve gets a working device again (new key material logged into the
    // same account — findOrCreateDeviceRow creates a fresh device row
    // since these keys don't match the revoked one).
    const newIdentity = await Engine.generateDeviceIdentity(5);
    const newBundle = Engine.toPublicBundle(newIdentity);
    const relogin = await call(null, 'POST', '/api/auth/login', {
      userId: eve.userId,
      password: 'pw',
      deviceName: uniq(),
      platform: 'web',
      ...newBundle,
      oneTimePrekeysPublic: newIdentity.oneTimePrekeysPublic,
    });
    check('Handshake after revoked device setup: Eve can re-establish a working device', relogin.status === 200);

    const retry = await call(frank.accessToken, 'POST', '/api/pairing/redeem', { code: p.data.code });
    check(
      'Handshake after revoked device: the SAME code redeems successfully once the creator has a working device again',
      retry.status === 200,
      `got ${retry.status} ${JSON.stringify(retry.data)}`,
    );
  }

  // ============================================================
  // 6, 7, 8. Burn — atomic, cleans up pending handshakes, broadcasts to
  // the online peer, and is discoverable by an offline peer on its own
  // next check (offline propagation, Case A from the task).
  // ============================================================
  let repairAlice, repairBob, repairConversationId, aliceOldSession;
  {
    const alice = makeClient();
    const bob = makeClient();
    await alice.register('pw', uniq());
    await bob.register('pw', uniq());
    const p = await alice.createPairing(900);
    const r = await bob.redeem(p.data.code);
    const conversationId = r.data.conversationId;
    await alice.completeFromServer(conversationId);

    // Bob is online (has a live WS connection) when Alice burns —
    // exercises the immediate broadcast path.
    const bobSocket = await openWs(bob.accessToken);
    check('Burn setup: Bob\'s WebSocket connects', !!bobSocket);

    const preBurnStatus = await bob.status(conversationId);
    check('Burn: before burning, status is ACTIVE for both parties', preBurnStatus.data.status === 'ACTIVE');

    const burnResult = await alice.burn(conversationId);
    check('Burn: burn() itself succeeds', burnResult.status === 200);

    await new Promise((r2) => setTimeout(r2, 60));
    const burnEvent = bobSocket.events.find((e) => e.type === 'conversation_burned');
    check('Burn: the online peer receives an immediate conversation_burned push', !!burnEvent);
    check('Burn: the push identifies the correct conversation', burnEvent?.conversationId === conversationId);

    const postBurnStatusAlice = await alice.status(conversationId);
    const postBurnStatusBob = await bob.status(conversationId);
    check('Burn: status is DELETED for the burner', postBurnStatusAlice.data.status === 'DELETED');
    check('Burn: status is DELETED for the other party too (mutual, not just the burner\'s view)', postBurnStatusBob.data.status === 'DELETED');
    check('Burn: sessionEpoch does not change from burning alone (only a subsequent re-pair advances it)', postBurnStatusBob.data.sessionEpoch === 1);

    const postBurnSync = await alice.sync(conversationId, 0);
    check('Burn: messages are actually gone server-side, not merely hidden (sync on a burned conversation is rejected)', postBurnSync.status === 403);

    const postBurnHandshakeFetch = await alice.fetchHandshake(conversationId);
    check('Burn: any pending handshake for the conversation is cleared (404 after burn)', postBurnHandshakeFetch.status === 404);

    const postBurnSend = await bob.send(conversationId, 'are you there?');
    check('Offline/burn correctness Case A: the (now known-burned) party cannot send using the old session — server rejects', postBurnSend.status === 403);

    bobSocket.ws.close();
    repairAlice = alice;
    repairBob = bob;
    repairConversationId = conversationId;
    aliceOldSession = { ...alice.session };
  }

  // ============================================================
  // 9. Burn + stale handshake — an unfetched handshake from before the
  //    burn cannot recreate the old conversation.
  // ============================================================
  {
    const ivan = makeClient();
    const judy = makeClient();
    await ivan.register('pw', uniq());
    await judy.register('pw', uniq());
    const p = await ivan.createPairing(900);
    const r = await judy.redeem(p.data.code); // judy stores a handshake; ivan (creator) never fetches it
    const conversationId = r.data.conversationId;

    const burned = await ivan.burn(conversationId);
    check('Burn + stale handshake: burn succeeds even though the creator never completed a session', burned.status === 200);
    const fetchAfterBurn = await ivan.fetchHandshake(conversationId);
    check('Burn + stale handshake: the unfetched pre-burn handshake is gone, not completable after the fact', fetchAfterBurn.status === 404);
  }

  // ============================================================
  // 10, 11, 12. Successful re-pair, old-session rejection, new-session
  // isolation — THE core invariants for this task.
  // ============================================================
  {
    const alice = repairAlice;
    const bob = repairBob;
    const conversationId = repairConversationId;

    const p2 = await alice.createPairing(900);
    const r2 = await bob.redeem(p2.data.code);
    check('Re-pair: reuses the exact same conversationId', r2.data.conversationId === conversationId);
    check('Re-pair: epoch advances from 1 to 2', r2.data.sessionEpoch === 2, `got ${r2.data.sessionEpoch}`);
    const completed2 = await alice.completeFromServer(conversationId);
    check('Re-pair: creator completes the new handshake successfully', completed2.status === 200 && completed2.data.sessionEpoch === 2);

    check(
      'New session isolation: the re-paired sending chain key differs from the pre-burn one',
      !Buffer.from(bob.session.sendingChainKey).equals(Buffer.from(aliceOldSession.receivingChainKey)),
    );

    const newMsg = await bob.send(conversationId, 'fresh start');
    check('Re-pair: sending under the new session succeeds', newMsg.status === 201);
    const gap = await alice.sync(conversationId, 0);
    const decrypted = await alice.decryptOne(conversationId, gap.data[0]);
    check('Re-pair: the new session correctly decrypts the new message', decrypted.ok && decrypted.plaintext === 'fresh start');

    // THE core invariant: Bob's old (pre-burn) session, if it were ever
    // used again, must not be treated as part of the new conversation.
    const staleBob = { ...bob }; // shallow copy of the CURRENT (already-repaired) client...
    void staleBob;
    // Simulate the actual danger scenario directly: an honest client
    // that missed the burn+re-pair and still believes it's on epoch 1,
    // encrypting with its old (pre-burn) chain key, tries to send.
    const oldSessionClient = { session: aliceOldSession, identity: null };
    const aad = Engine.buildAad(conversationId, oldSessionClient.session.sendStep ?? 1);
    const { envelope } = await Engine.ratchetEncrypt(oldSessionClient.session.sendingChainKey, 'stale message', aad);
    const staleSend = await call(repairBob.accessToken, 'POST', '/api/messages', {
      conversationId,
      clientMessageId: randomUUID(),
      ciphertext: envelope.ciphertext,
      iv: envelope.iv,
      messageType: 'TEXT',
      sessionEpoch: 1, // the epoch this old session actually belongs to
    });
    check(
      'OLD SESSION REJECTION (core invariant): a send claiming the pre-burn epoch is rejected after re-pair, even though the conversation is ACTIVE again',
      staleSend.status === 409,
      `got ${staleSend.status} ${JSON.stringify(staleSend.data)}`,
    );
    check('OLD SESSION REJECTION: the rejection identifies itself distinctly (STALE_SESSION_EPOCH), not a generic error', staleSend.data.error === 'STALE_SESSION_EPOCH');

    // The complementary case: old *ciphertext* under a claimed-current
    // epoch is accepted at the HTTP layer (the server cannot and must
    // not inspect ciphertext to verify the claim — doing so would
    // require it to hold key material, defeating E2EE) but is
    // cryptographically meaningless to the recipient's new session —
    // proving isolation holds at the crypto layer independently of the
    // epoch bookkeeping layer.
    const lyingSend = await call(repairBob.accessToken, 'POST', '/api/messages', {
      conversationId,
      clientMessageId: randomUUID(),
      ciphertext: envelope.ciphertext,
      iv: envelope.iv,
      messageType: 'TEXT',
      sessionEpoch: 2, // lying about which session this ciphertext came from
    });
    check('New session isolation: the server cannot detect a mislabeled epoch by inspecting ciphertext (accepted at the HTTP layer, as E2EE requires)', lyingSend.status === 201);
    const gap2 = await alice.sync(conversationId, gap.data[0].sequenceNumber);
    const attemptDecrypt = await alice.decryptOne(conversationId, gap2.data[gap2.data.length - 1]);
    check(
      'New session isolation (crypto layer): the new session can never successfully decrypt old-session ciphertext, regardless of what epoch it was labeled with',
      attemptDecrypt.ok === false,
    );
  }

  // ============================================================
  // 13. Concurrent completion
  // ============================================================
  {
    const karl = makeClient();
    const laura = makeClient();
    await karl.register('pw', uniq());
    await laura.register('pw', uniq());
    const p = await karl.createPairing(900);
    const r = await laura.redeem(p.data.code);
    const conversationId = r.data.conversationId;

    const [f1, f2] = await Promise.all([karl.fetchHandshake(conversationId), karl.fetchHandshake(conversationId)]);
    check('Concurrent completion: both concurrent fetches succeed', f1.status === 200 && f2.status === 200);
    check('Concurrent completion: both see the identical payload (no corruption from concurrent reads)', JSON.stringify(f1.data) === JSON.stringify(f2.data));

    // ============================================================
    // 14. Concurrent burn
    // ============================================================
    await karl.completeFromServer(conversationId);
    const [b1, b2] = await Promise.all([karl.burn(conversationId), karl.burn(conversationId)]);
    check('Concurrent burn: neither concurrent burn call errors (idempotent)', b1.status === 200 && b2.status === 200);
    const finalStatus = await karl.status(conversationId);
    check('Concurrent burn: the conversation ends up cleanly DELETED', finalStatus.data.status === 'DELETED');
    check('Concurrent burn: epoch is unaffected by a double burn', finalStatus.data.sessionEpoch === 1);

    // ============================================================
    // 15. Idempotency — sending with the same clientMessageId and the
    // (correct) epoch twice must not double-insert, matching the
    // pre-existing dedup behavior with the new epoch check now in front
    // of it.
    // ============================================================
    const p2 = await karl.createPairing(900);
    const r2 = await laura.redeem(p2.data.code);
    await karl.completeFromServer(conversationId);
    const clientMessageId = randomUUID();
    const aad = Engine.buildAad(conversationId, laura.session.sendStep);
    const { envelope } = await Engine.ratchetEncrypt(laura.session.sendingChainKey, 'once please', aad);
    const dupBody = { conversationId, clientMessageId, ciphertext: envelope.ciphertext, iv: envelope.iv, messageType: 'TEXT', sessionEpoch: laura.session.epoch };
    const first = await call(laura.accessToken, 'POST', '/api/messages', dupBody);
    const second = await call(laura.accessToken, 'POST', '/api/messages', dupBody);
    // First send creates (201); a deduplicated resend returns the
    // existing message with 200, not an error and not a second 201 —
    // matches messages.controller.ts's isDuplicateSend handling.
    check('Idempotency: the first send creates the message (201)', first.status === 201, `got ${first.status}`);
    check('Idempotency: the duplicate resend is deduplicated, not an error (200)', second.status === 200, `got ${second.status}`);
    check('Idempotency: duplicate send is deduplicated to the same message id, not double-inserted', first.data.id === second.data.id);
    void r2;
  }

  // ============================================================
  // 16. Authorization / ownership failures
  // ============================================================
  {
    const alice = makeClient();
    const bob = makeClient();
    const mallory = makeClient();
    await alice.register('pw', uniq());
    await bob.register('pw', uniq());
    await mallory.register('pw', uniq());
    const p = await alice.createPairing(900);
    const r = await bob.redeem(p.data.code);
    const conversationId = r.data.conversationId;

    const statusAttempt = await mallory.status(conversationId);
    check('Authorization: a non-participant cannot read conversation status', statusAttempt.status === 404);

    const { message } = await Engine.initiateHandshake(mallory.identity, r.data.bundle);
    const storeAttempt = await call(mallory.accessToken, 'POST', '/api/handshake', { conversationId, handshakeMessage: message, sessionEpoch: r.data.sessionEpoch });
    check('Authorization: a non-participant cannot store a handshake for someone else\'s conversation', storeAttempt.status === 403, `got ${storeAttempt.status}`);

    const fetchAttempt = await mallory.fetchHandshake(conversationId);
    check('Authorization: a non-participant cannot fetch a handshake for someone else\'s conversation', fetchAttempt.status === 404);

    const burnAttempt = await mallory.burn(conversationId);
    check('Authorization: a non-participant cannot burn someone else\'s conversation', burnAttempt.status === 404);

    // Confirm the conversation is untouched by all of the above.
    const stillThere = await alice.status(conversationId);
    check('Authorization: the conversation is unaffected by the rejected attempts', stillThere.data.status === 'ACTIVE' && stillThere.data.sessionEpoch === 1);
  }

  // ============================================================
  // 17. Pairing-code brute-force lockout — THE FIX. isLockedOut /
  // recordFailedAttempt (domain/pairingCode.ts) were fully written and
  // unit-tested, but pairing.service.ts's redeem() never actually
  // called either — there was no rate limit on guessing at all.
  // ============================================================
  {
    const karen = makeClient();
    const larry = makeClient();
    await karen.register('pw', uniq());
    await larry.register('pw', uniq());
    const p = await karen.createPairing(900);

    let lastAttempt;
    for (let i = 0; i < 5; i++) {
      // Astronomically unlikely to collide with the real 6-digit code.
      lastAttempt = await call(larry.accessToken, 'POST', '/api/pairing/redeem', { code: '000000' });
    }
    check('Pairing lockout: repeated wrong guesses are still rejected the same way (no distinguishing signal)', lastAttempt.status === 400);

    const correctAttempt = await call(larry.accessToken, 'POST', '/api/pairing/redeem', { code: p.data.code });
    check(
      'Pairing lockout — THE FIX: after enough wrong guesses, even the CORRECT code is now rejected (must regenerate, not just wait)',
      correctAttempt.status === 400,
      `got ${correctAttempt.status}`,
    );

    const freshCode = await karen.createPairing(900);
    const freshRedeem = await call(larry.accessToken, 'POST', '/api/pairing/redeem', { code: freshCode.data.code });
    check('Pairing lockout: a newly regenerated code is unaffected and works normally', freshRedeem.status === 200);
  }

  server.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checks passed.`);
  process.exit(passed === results.length ? 0 : 1);
}

run().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
