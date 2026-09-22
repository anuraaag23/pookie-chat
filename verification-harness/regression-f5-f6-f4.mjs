// Regression test suite for Security Audit findings:
// - F4: sessionEpoch mandatory server-side
// - F5: account deletion explicitly closes live sockets
// - F6: replyToMessageId validated against same conversation
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
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  }

  function openWs(token) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}?token=${encodeURIComponent(token)}`);
      let closed = false;
      const events = [];
      ws.addEventListener('close', () => {
        closed = true;
      });
      ws.addEventListener('message', (evt) => {
        try {
          events.push(JSON.parse(evt.data));
        } catch {
          events.push(evt.data);
        }
      });
      ws.addEventListener('open', () => {
        setTimeout(() => resolve({ ws, get closed() { return closed; }, events }), 50);
      });
      ws.addEventListener('error', reject);
    });
  }

  async function registerDevice(userId, password, identity, deviceName, platform = 'web') {
    const bundle = Engine.toPublicBundle(identity);
    const body = { deviceName, platform, ...bundle, oneTimePrekeysPublic: identity.oneTimePrekeysPublic };
    if (userId) {
      return (await call(null, 'POST', '/api/auth/login', { userId, password, ...body })).data;
    }
    const username = `harness_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    return (await call(null, 'POST', '/api/auth/register', { password, username, ...body })).data;
  }

  console.log('--- Setting up test users ---');
  const aliceIdentity = await Engine.generateDeviceIdentity(3);
  const bobIdentity = await Engine.generateDeviceIdentity(3);
  const alice = await registerDevice(null, 'alice-pass-123', aliceIdentity, 'Alice Phone');
  const bob = await registerDevice(null, 'bob-pass-123', bobIdentity, 'Bob Phone');

  // Pair Alice and Bob
  const p1 = await call(alice.accessToken, 'POST', '/api/pairing/create', { durationSeconds: 300 });
  const r1 = await call(bob.accessToken, 'POST', '/api/pairing/redeem', { code: p1.data.code });
  const conversationId1 = r1.data.conversationId;
  const epoch1 = r1.data.sessionEpoch;
  check('Pairing completed at epoch 1', epoch1 === 1);

  // =========================================================================
  // F4: SESSION EPOCH HARDENING
  // =========================================================================
  console.log('\n--- F4: sessionEpoch Hardening ---');

  // F4.1: POST /api/messages without sessionEpoch
  const noEpochMsg = await call(alice.accessToken, 'POST', '/api/messages', {
    conversationId: conversationId1,
    clientMessageId: randomUUID(),
    ciphertext: 'dGVzdA==',
    iv: 'AAAAAAAAAAAAAAAA',
    messageType: 'TEXT',
  });
  check('F4.1: Sending message without sessionEpoch is rejected with 400', noEpochMsg.status === 400, `got ${noEpochMsg.status}`);

  // F4.2: POST /api/messages with non-integer sessionEpoch
  const invalidEpochMsg = await call(alice.accessToken, 'POST', '/api/messages', {
    conversationId: conversationId1,
    clientMessageId: randomUUID(),
    ciphertext: 'dGVzdA==',
    iv: 'AAAAAAAAAAAAAAAA',
    messageType: 'TEXT',
    sessionEpoch: '1',
  });
  check('F4.2: Sending message with non-integer sessionEpoch is rejected with 400', invalidEpochMsg.status === 400, `got ${invalidEpochMsg.status}`);

  // F4.3: POST /api/handshake without sessionEpoch
  const noEpochHandshake = await call(alice.accessToken, 'POST', '/api/handshake', {
    conversationId: conversationId1,
    handshakeMessage: { test: 1 },
  });
  check('F4.3: Storing handshake without sessionEpoch is rejected with 400', noEpochHandshake.status === 400, `got ${noEpochHandshake.status}`);

  // F4.4: POST /api/handshake with valid sessionEpoch
  const validHandshake = await call(bob.accessToken, 'POST', '/api/handshake', {
    conversationId: conversationId1,
    handshakeMessage: { sample: 'init' },
    sessionEpoch: 1,
  });
  check('F4.4: Storing handshake with valid sessionEpoch succeeds (201)', validHandshake.status === 201, `got ${validHandshake.status}`);

  // F4.5: POST /api/messages with valid sessionEpoch
  const validMsg = await call(alice.accessToken, 'POST', '/api/messages', {
    conversationId: conversationId1,
    clientMessageId: randomUUID(),
    ciphertext: 'dGVzdA==',
    iv: 'AAAAAAAAAAAAAAAA',
    messageType: 'TEXT',
    sessionEpoch: 1,
  });
  check('F4.5: Sending message with matching sessionEpoch succeeds (201)', validMsg.status === 201, `got ${validMsg.status}`);
  const messageId1 = validMsg.data.id;

  // F4.6: POST /api/messages with stale sessionEpoch
  const staleMsg = await call(alice.accessToken, 'POST', '/api/messages', {
    conversationId: conversationId1,
    clientMessageId: randomUUID(),
    ciphertext: 'dGVzdA==',
    iv: 'AAAAAAAAAAAAAAAA',
    messageType: 'TEXT',
    sessionEpoch: 99,
  });
  check('F4.6: Sending message with stale sessionEpoch is rejected with 409', staleMsg.status === 409, `got ${staleMsg.status}`);

  // =========================================================================
  // F6: REPLY MESSAGE VALIDATION
  // =========================================================================
  console.log('\n--- F6: Reply Message Same-Conversation Validation ---');

  // F6.1: Valid reply pointing to message in same conversation
  const validReply = await call(bob.accessToken, 'POST', '/api/messages', {
    conversationId: conversationId1,
    clientMessageId: randomUUID(),
    ciphertext: 'cmVwbHk=',
    iv: 'AAAAAAAAAAAAAAAA',
    messageType: 'TEXT',
    sessionEpoch: 1,
    replyToMessageId: messageId1,
  });
  check('F6.1: Valid reply to existing message in same conversation succeeds', validReply.status === 201, `got ${validReply.status}`);

  // F6.2: Nonexistent reply message ID
  const fakeId = randomUUID();
  const nonexistentReply = await call(bob.accessToken, 'POST', '/api/messages', {
    conversationId: conversationId1,
    clientMessageId: randomUUID(),
    ciphertext: 'cmVwbHk=',
    iv: 'AAAAAAAAAAAAAAAA',
    messageType: 'TEXT',
    sessionEpoch: 1,
    replyToMessageId: fakeId,
  });
  check('F6.2: Reply to nonexistent message is rejected with 404', nonexistentReply.status === 404, `got ${nonexistentReply.status}`);
  check('F6.2 error message is clean', nonexistentReply.data.error === 'Referenced reply message not found');

  // Setup second conversation (Bob & Carol)
  const carolIdentity = await Engine.generateDeviceIdentity(3);
  const carol = await registerDevice(null, 'carol-pass-123', carolIdentity, 'Carol Phone');
  const p2 = await call(bob.accessToken, 'POST', '/api/pairing/create', { durationSeconds: 300 });
  const r2 = await call(carol.accessToken, 'POST', '/api/pairing/redeem', { code: p2.data.code });
  const conversationId2 = r2.data.conversationId;

  // Carol sends message in Conversation 2
  const carolMsg = await call(carol.accessToken, 'POST', '/api/messages', {
    conversationId: conversationId2,
    clientMessageId: randomUUID(),
    ciphertext: 'Y2Fyb2w=',
    iv: 'AAAAAAAAAAAAAAAA',
    messageType: 'TEXT',
    sessionEpoch: 1,
  });
  const messageId2 = carolMsg.data.id;
  check('Carol message in conversation 2 created', carolMsg.status === 201);

  // F6.3: Cross-conversation reply (Bob tries to reply in Conversation 1 pointing to messageId2 from Conversation 2)
  const crossConvoReply = await call(bob.accessToken, 'POST', '/api/messages', {
    conversationId: conversationId1,
    clientMessageId: randomUUID(),
    ciphertext: 'Y3Jvc3M=',
    iv: 'AAAAAAAAAAAAAAAA',
    messageType: 'TEXT',
    sessionEpoch: 1,
    replyToMessageId: messageId2,
  });
  check('F6.3: Reply to message belonging to different conversation is rejected with 404', crossConvoReply.status === 404, `got ${crossConvoReply.status}`);
  check('F6.4: Cross-convo error matches nonexistent error exactly (no leak)', crossConvoReply.data.error === nonexistentReply.data.error);

  // =========================================================================
  // F5: ACCOUNT DELETION LIVE SOCKETS
  // =========================================================================
  console.log('\n--- F5: Account Deletion WebSocket Disconnection ---');

  const eveIdentity = await Engine.generateDeviceIdentity(3);
  const frankIdentity = await Engine.generateDeviceIdentity(3);
  const eve = await registerDevice(null, 'eve-pass-123', eveIdentity, 'Eve Phone');
  const frank = await registerDevice(null, 'frank-pass-123', frankIdentity, 'Frank Phone');

  // Pair Eve and Frank
  const p3 = await call(eve.accessToken, 'POST', '/api/pairing/create', { durationSeconds: 300 });
  const r3 = await call(frank.accessToken, 'POST', '/api/pairing/redeem', { code: p3.data.code });
  const conversationId3 = r3.data.conversationId;

  // Open live sockets for both Eve and Frank
  const eveConn = await openWs(eve.accessToken);
  const frankConn = await openWs(frank.accessToken);
  check('Eve live WebSocket connected', !eveConn.closed);
  check('Frank live WebSocket connected', !frankConn.closed);

  // Eve deletes her account
  const deleteRes = await call(eve.accessToken, 'DELETE', '/api/auth/account', { password: 'eve-pass-123' });
  check('F5.1: Account deletion succeeds (200)', deleteRes.status === 200);

  // Wait a short moment for socket close event loop processing
  await new Promise((r) => setTimeout(r, 100));

  check('F5.2: Eve active WebSocket is disconnected immediately upon account deletion', eveConn.closed === true);
  check('F5.3: Frank socket remains connected and unaffected', frankConn.closed === false);

  // Check Frank received conversation_burned
  const burnedEvent = frankConn.events.find((e) => e.type === 'conversation_burned' && e.conversationId === conversationId3);
  check('F5.4: Peer (Frank) received conversation_burned event', !!burnedEvent);

  // Eve cannot perform authenticated requests
  const postDeleteCall = await call(eve.accessToken, 'GET', '/api/auth/sessions');
  check('F5.5: Deleted user access token rejected on subsequent API calls', postDeleteCall.status === 401);

  // Close server
  server.close();

  const failed = results.filter((r) => !r).length;
  console.log(`\n=================================================`);
  console.log(`Total checks: ${results.length}, Passed: ${results.length - failed}, Failed: ${failed}`);
  frankConn.ws.close();
  if (failed > 0) process.exit(1);
  process.exit(0);
}

run().catch((err) => {
  console.error('Test run error:', err);
  process.exit(1);
});
