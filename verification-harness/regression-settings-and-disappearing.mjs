// Regression tests for three related fixes found during the V1
// functional-gap audit:
//
//  1. Disappearing messages were computed and stored (disappearAt) but
//     never read back anywhere — no filter, no cleanup. A message could
//     be delivered *after* it should have disappeared, and once
//     delivered would sit in the database forever.
//  2. sync()'s own delivery path (as opposed to the immediate-push path)
//     never computed disappearAt at all for the 'delivered' trigger —
//     meaning a disappearing timer anchored to "delivered" silently
//     never applied to any message the recipient was offline for at
//     send time.
//  3. readReceiptsEnabled / typingIndicatorEnabled were real settings
//     with a real UI, but nothing on the server (or client) ever
//     checked them — toggling them off had zero actual effect.
//
// Mirrors server.mjs's real logic (which itself imports the real
// domain/messageState.ts functions directly), same approach as every
// other regression file here.
import { createHarness } from './server.mjs';
import * as Engine from '../apps/web/lib/crypto/engine.ts';
import { randomUUID } from 'node:crypto';

const results = [];
function check(label, cond, detail = '') {
  results.push(!!cond);
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${label}${detail ? ' (' + detail + ')' : ''}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function run() {
  const { server, db, cleanupExpiredMessages } = createHarness();
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

  async function registerAndPair() {
    const aliceIdentity = await Engine.generateDeviceIdentity(5);
    const aliceBundle = Engine.toPublicBundle(aliceIdentity);
    const alice = (
      await call(null, 'POST', '/api/auth/register', { password: 'pw', username: `harness_a_${randomUUID().replace(/-/g, '').slice(0, 12)}`, deviceName: 'a-' + randomUUID(), platform: 'web', ...aliceBundle, oneTimePrekeysPublic: aliceIdentity.oneTimePrekeysPublic })
    ).data;
    const bobIdentity = await Engine.generateDeviceIdentity(5);
    const bobBundle = Engine.toPublicBundle(bobIdentity);
    const bob = (
      await call(null, 'POST', '/api/auth/register', { password: 'pw', username: `harness_b_${randomUUID().replace(/-/g, '').slice(0, 12)}`, deviceName: 'b-' + randomUUID(), platform: 'web', ...bobBundle, oneTimePrekeysPublic: bobIdentity.oneTimePrekeysPublic })
    ).data;
    const p = await call(alice.accessToken, 'POST', '/api/pairing/create', { durationSeconds: 900 });
    const r = await call(bob.accessToken, 'POST', '/api/pairing/redeem', { code: p.data.code });
    const conversationId = r.data.conversationId;
    const initiated = await Engine.initiateHandshake(bobIdentity, r.data.bundle);
    await call(bob.accessToken, 'POST', '/api/handshake', { conversationId, handshakeMessage: initiated.message, sessionEpoch: r.data.sessionEpoch });
    const fetched = await call(alice.accessToken, 'GET', `/api/handshake?conversationId=${conversationId}`);
    const completed = await Engine.completeHandshake(aliceIdentity, fetched.data.handshakeMessage);
    return {
      alice: { ...alice, identity: aliceIdentity, session: { ...completed.session, sendStep: 0, recvStep: 0, epoch: fetched.data.sessionEpoch } },
      bob: { ...bob, identity: bobIdentity, session: { ...initiated.session, sendStep: 0, recvStep: 0, epoch: r.data.sessionEpoch } },
      conversationId,
    };
  }

  async function send(from, to, conversationId, text) {
    const aad = Engine.buildAad(conversationId, from.session.sendStep);
    const { envelope, nextChainKey } = await Engine.ratchetEncrypt(from.session.sendingChainKey, text, aad);
    from.session.sendingChainKey = nextChainKey;
    from.session.sendStep += 1;
    return call(from.accessToken, 'POST', '/api/messages', {
      conversationId,
      clientMessageId: randomUUID(),
      ciphertext: envelope.ciphertext,
      iv: envelope.iv,
      messageType: 'TEXT',
      sessionEpoch: from.session.epoch,
    });
  }

  // ============================================================
  // Settings: defaults and persistence
  // ============================================================
  {
    const { alice } = await registerAndPair();
    const initial = await call(alice.accessToken, 'GET', '/api/settings');
    check('Settings: defaults are both enabled', initial.status === 200 && initial.data.readReceiptsEnabled === true && initial.data.typingIndicatorEnabled === true);
    const patched = await call(alice.accessToken, 'PATCH', '/api/settings', { readReceiptsEnabled: false });
    check('Settings: PATCH updates the targeted field', patched.data.readReceiptsEnabled === false);
    check('Settings: PATCH leaves the untouched field alone', patched.data.typingIndicatorEnabled === true);
  }

  // ============================================================
  // Read receipts: THE FIX — actually respected now
  // ============================================================
  {
    const { alice, bob, conversationId } = await registerAndPair();
    const aliceSocket = await openWs(alice.accessToken);

    // Bob disables read receipts, then reads Alice's message.
    await call(bob.accessToken, 'PATCH', '/api/settings', { readReceiptsEnabled: false });
    const sent1 = await send(alice, bob, conversationId, 'can you see this');
    const markRead1 = await call(bob.accessToken, 'POST', `/api/messages/${sent1.data.id}/read`, {});
    check('Read receipts (disabled): marking read still succeeds', markRead1.status === 200);
    await sleep(60);
    check(
      "Read receipts (disabled): THE FIX — the sender receives NO read_receipt push when the reader has disabled read receipts",
      !aliceSocket.events.some((e) => e.type === 'read_receipt'),
    );

    // Contrast: Bob re-enables it, reads another message, sender IS told.
    await call(bob.accessToken, 'PATCH', '/api/settings', { readReceiptsEnabled: true });
    const sent2 = await send(alice, bob, conversationId, 'now can you see this');
    await call(bob.accessToken, 'POST', `/api/messages/${sent2.data.id}/read`, {});
    await sleep(60);
    check(
      'Read receipts (enabled): the sender DOES receive a read_receipt push once re-enabled',
      aliceSocket.events.some((e) => e.type === 'read_receipt' && e.messageId === sent2.data.id),
    );
    aliceSocket.ws.close();
  }

  // ============================================================
  // Typing indicator: THE FIX — actually respected now
  // ============================================================
  {
    const { alice, bob, conversationId } = await registerAndPair();
    const bobSocket = await openWs(bob.accessToken);
    const aliceSocket = await openWs(alice.accessToken);

    await call(alice.accessToken, 'PATCH', '/api/settings', { typingIndicatorEnabled: false });
    aliceSocket.ws.send(JSON.stringify({ type: 'typing', conversationId, isTyping: true }));
    await sleep(80);
    check(
      'Typing indicator (disabled): THE FIX — the other party receives NO typing event when disabled',
      !bobSocket.events.some((e) => e.type === 'typing'),
    );

    await call(alice.accessToken, 'PATCH', '/api/settings', { typingIndicatorEnabled: true });
    aliceSocket.ws.send(JSON.stringify({ type: 'typing', conversationId, isTyping: true }));
    await sleep(80);
    check(
      'Typing indicator (enabled): the other party DOES receive the typing event once re-enabled',
      bobSocket.events.some((e) => e.type === 'typing' && e.isTyping === true),
    );
    bobSocket.ws.close();
    aliceSocket.ws.close();
  }

  // ============================================================
  // Disappearing messages: SENT trigger, actual cleanup
  // ============================================================
  {
    const { alice, bob, conversationId } = await registerAndPair();
    const bobSocket = await openWs(bob.accessToken);
    await call(alice.accessToken, 'POST', `/api/conversations/${conversationId}/disappearing`, { timerSeconds: 1, trigger: 'SENT' });

    const sent = await send(alice, bob, conversationId, 'this should vanish');
    check('Disappearing (sent): send succeeds normally', sent.status === 201);

    const preExpiry = await call(bob.accessToken, 'GET', `/api/messages/sync?conversationId=${conversationId}&after=0`);
    check('Disappearing (sent): still deliverable before the timer elapses', preExpiry.data.length === 1);

    await sleep(1600);

    // Defensive filter check — BEFORE running cleanup, sync() must
    // already refuse to hand out an expired message on its own.
    const postExpiryNoSweep = await call(bob.accessToken, 'GET', `/api/messages/sync?conversationId=${conversationId}&after=0`);
    check(
      "Disappearing (sent): sync()'s own defensive filter excludes an expired message even before any cleanup sweep has run",
      postExpiryNoSweep.data.length === 0,
    );

    cleanupExpiredMessages();
    await sleep(60);
    check(
      'Disappearing (sent): an already-connected recipient is told the message is gone (message_deleted push)',
      bobSocket.events.some((e) => e.type === 'message_deleted' && e.messageId === sent.data.id),
    );

    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(sent.data.id);
    check('Disappearing (sent): the row is tombstoned (deleted_at set, ciphertext wiped), not left intact', !!row.deleted_at && row.ciphertext === '');
    bobSocket.ws.close();
  }

  // ============================================================
  // Disappearing messages: DELIVERED trigger via sync — THE FIX
  // (previously only the immediate-push path computed this at all)
  // ============================================================
  {
    const { alice, bob, conversationId } = await registerAndPair();
    await call(alice.accessToken, 'POST', `/api/conversations/${conversationId}/disappearing`, { timerSeconds: 1, trigger: 'DELIVERED' });

    // Bob is offline (no WS connection) when Alice sends — delivery can
    // only happen later, via sync(), not the immediate-push path.
    const sent = await send(alice, bob, conversationId, 'delivered-trigger test');
    const rowBeforeSync = db.prepare('SELECT * FROM messages WHERE id = ?').get(sent.data.id);
    check('Disappearing (delivered) setup: not yet delivered, so disappearAt is not set yet', rowBeforeSync.delivered_at === null && rowBeforeSync.disappear_at === null);

    // Bob comes online later and syncs — this is the delivery path under test.
    await call(bob.accessToken, 'GET', `/api/messages/sync?conversationId=${conversationId}&after=0`);
    const rowAfterSync = db.prepare('SELECT * FROM messages WHERE id = ?').get(sent.data.id);
    check(
      'Disappearing (delivered) — THE FIX: syncing (not just live push) now correctly starts the disappear timer',
      !!rowAfterSync.delivered_at && !!rowAfterSync.disappear_at,
      `delivered_at=${rowAfterSync.delivered_at} disappear_at=${rowAfterSync.disappear_at}`,
    );

    await sleep(1600);
    cleanupExpiredMessages();
    const rowAfterCleanup = db.prepare('SELECT * FROM messages WHERE id = ?').get(sent.data.id);
    check(
      'Disappearing (delivered): the message is actually cleaned up once its delivered-anchored timer elapses',
      !!rowAfterCleanup.deleted_at && rowAfterCleanup.ciphertext === '',
    );
  }

  // ============================================================
  // Disappearing messages: READ trigger
  // ============================================================
  {
    const { alice, bob, conversationId } = await registerAndPair();
    await call(alice.accessToken, 'POST', `/api/conversations/${conversationId}/disappearing`, { timerSeconds: 1, trigger: 'READ' });
    const sent = await send(alice, bob, conversationId, 'read-trigger test');
    await call(bob.accessToken, 'GET', `/api/messages/sync?conversationId=${conversationId}&after=0`); // delivered
    await call(bob.accessToken, 'POST', `/api/messages/${sent.data.id}/read`, {});
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(sent.data.id);
    check('Disappearing (read): marking read starts the disappear timer', !!row.disappear_at);
    // Generous margin over the 1-second timer — by this point in the
    // file several earlier blocks have already run real crypto and
    // network round trips, and a tight margin here was observed to be
    // genuinely flaky (confirmed correct in isolation with a wide
    // margin; this is test timing slack, not a product bug — see the
    // final report).
    await sleep(2000);
    cleanupExpiredMessages();
    const rowAfterCleanup = db.prepare('SELECT * FROM messages WHERE id = ?').get(sent.data.id);
    check(
      'Disappearing (read): the message is cleaned up once its read-anchored timer elapses',
      !!rowAfterCleanup.deleted_at && rowAfterCleanup.ciphertext === '',
    );
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
