// Same scenario as run_e2e.py, run a different way after the Playwright-
// orchestrated version proved unreliable to execute in this particular
// sandbox (see the final report for what was tried). This keeps
// everything that actually matters real: real HTTP requests over a real
// loopback socket, the real hand-rolled WebSocket protocol, a real
// SQLite-backed server process (imported directly, not mocked), and the
// real crypto engine running under Node's WebCrypto — which was already
// separately confirmed (via Playwright, earlier in this session) to
// implement the same primitives the same way real Chromium does. The
// only thing this version doesn't do is run inside an actual browser
// tab; everything else about the flow is identical.

import { createHarness } from './server.mjs';
import * as Engine from '../apps/web/lib/crypto/engine.ts';
import { openSync, writeSync, fsyncSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const logFd = openSync('/tmp/node_e2e_progress.log', 'w');
function plog(line) {
  writeSync(logFd, line + '\n');
  fsyncSync(logFd);
  console.log(line);
}

const results = [];
function check(label, condition, detail = '') {
  results.push({ label, pass: !!condition });
  plog(`${condition ? 'PASS' : 'FAIL'} - ${label}${detail ? ' (' + detail + ')' : ''}`);
}

function makeClient(baseUrl) {
  const state = { session: null, sendStep: 0, recvStep: 0, events: [] };
  async function api(method, path, body) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(state.accessToken ? { Authorization: `Bearer ${state.accessToken}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(data)}`);
    return data;
  }
  return {
    state,
    async register(password, deviceName) {
      state.identity = await Engine.generateDeviceIdentity(10);
      const bundle = Engine.toPublicBundle(state.identity);
      const result = await api('POST', '/api/auth/register', {
        password, username: `harness_${randomUUID().replace(/-/g, '').slice(0, 16)}`, deviceName, platform: 'web',
        identityDhPublic: bundle.identityDhPublic,
        identitySigningPublic: bundle.identitySigningPublic,
        signedPrekeyPublic: bundle.signedPrekeyPublic,
        signedPrekeySignature: bundle.signedPrekeySignature,
        oneTimePrekeysPublic: state.identity.oneTimePrekeysPublic,
      });
      state.userId = result.userId;
      state.deviceId = result.deviceId;
      state.accessToken = result.accessToken;
      return result;
    },
    createPairingCode: (durationSeconds) => api('POST', '/api/pairing/create', { durationSeconds }),
    async redeemPairingCode(code) {
      const result = await api('POST', '/api/pairing/redeem', { code });
      const { session, message } = await Engine.initiateHandshake(state.identity, result.bundle);
      state.session = session;
      state.epoch = result.sessionEpoch || 1;
      await api('POST', '/api/handshake', { conversationId: result.conversationId, handshakeMessage: message, sessionEpoch: state.epoch });
      return result;
    },
    async completeHandshakeFromServer(conversationId) {
      const { handshakeMessage, sessionEpoch } = await api('GET', `/api/handshake?conversationId=${conversationId}`);
      const { session } = await Engine.completeHandshake(state.identity, handshakeMessage);
      state.session = session;
      state.epoch = sessionEpoch || 1;
    },
    connectWs() {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}?token=${encodeURIComponent(state.accessToken)}`);
        ws.addEventListener('open', () => resolve());
        ws.addEventListener('error', reject);
        ws.addEventListener('message', (evt) => state.events.push(JSON.parse(evt.data)));
        state.ws = ws;
      });
    },
    async sendMessage(conversationId, plaintext) {
      const clientMessageId = randomUUID();
      const aad = Engine.buildAad(conversationId, state.sendStep);
      state.sendStep += 1;
      const { envelope, nextChainKey } = await Engine.ratchetEncrypt(state.session.sendingChainKey, plaintext, aad);
      state.session.sendingChainKey = nextChainKey;
      return api('POST', '/api/messages', { conversationId, clientMessageId, ciphertext: envelope.ciphertext, iv: envelope.iv, messageType: 'TEXT', sessionEpoch: state.epoch || 1 });
    },
    async decryptOne(conversationId, m) {
      const aad = Engine.buildAad(conversationId, state.recvStep);
      state.recvStep += 1;
      const result = await Engine.ratchetDecrypt(state.session.receivingChainKey, { ciphertext: m.ciphertext, iv: m.iv }, aad);
      state.session.receivingChainKey = result.nextChainKey;
      return result.plaintext;
    },
    async syncMessages(conversationId, after) {
      const gap = await api('GET', `/api/messages/sync?conversationId=${conversationId}&after=${after}`);
      const out = [];
      for (const m of gap) out.push({ id: m.id, plaintext: await this.decryptOne(conversationId, m) });
      return out;
    },
    markRead: (id) => api('POST', `/api/messages/${id}/read`, {}),
    sendTyping(conversationId, isTyping) {
      state.ws.send(JSON.stringify({ type: 'typing', conversationId, isTyping }));
    },
    blockConversation: (id) => api('POST', `/api/conversations/${id}/block`, {}),
    clearEvents: () => (state.events = []),
  };
}

async function main() {
  plog('starting harness');
  const { server } = createHarness();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;
  plog(`harness listening on ${port}`);

  const alice = makeClient(baseUrl);
  const bob = makeClient(baseUrl);
  plog('clients constructed, registering alice');

  const aliceReg = await alice.register('alice-password-123', 'Alice Laptop');
  plog('alice registered');
  const bobReg = await bob.register('bob-password-456', 'Bob Phone');
  plog('bob registered');
  check('Alice registered with a real user/device id', !!(aliceReg.userId && aliceReg.deviceId));
  check('Bob registered with a real user/device id', !!(bobReg.userId && bobReg.deviceId));
  check('Alice and Bob got different user ids', aliceReg.userId !== bobReg.userId);

  const pairing = await alice.createPairingCode(900);
  check('Pairing code is 6 digits', /^\d{6}$/.test(pairing.code), pairing.code);

  const wrongCode = pairing.code === '111111' ? '222222' : '111111';
  let badRedeemMsg = 'no error';
  try { await bob.redeemPairingCode(wrongCode); } catch (e) { badRedeemMsg = e.message; }
  check('Wrong pairing code is rejected', badRedeemMsg.includes('400'), badRedeemMsg);

  const redeemed = await bob.redeemPairingCode(pairing.code);
  check('Correct pairing code succeeds and returns a conversation', !!redeemed.conversationId);
  const conversationId = redeemed.conversationId;

  let reRedeemMsg = 'no error';
  try { await alice.redeemPairingCode(pairing.code); } catch (e) { reRedeemMsg = e.message; }
  check('A used pairing code cannot be redeemed a second time', reRedeemMsg.includes('400'), reRedeemMsg);

  await alice.completeHandshakeFromServer(conversationId);
  check('Alice completed her side of the X3DH handshake without error', true);

  const msg1 = await bob.sendMessage(conversationId, 'Hey Alice, are you around?');
  const msg2 = await bob.sendMessage(conversationId, 'Sent this while you were offline');
  check('Bob sent 2 messages while Alice was offline', msg1.sequenceNumber === 1 && msg2.sequenceNumber === 2);
  check('Neither message was marked delivered yet (Alice not connected)', msg1.delivered === false && msg2.delivered === false);

  await alice.connectWs();
  const synced = await alice.syncMessages(conversationId, 0);
  check('Alice synced exactly 2 messages after reconnecting', synced.length === 2);
  check(
    'Both offline messages decrypted correctly, in order',
    synced[0]?.plaintext === 'Hey Alice, are you around?' && synced[1]?.plaintext === 'Sent this while you were offline',
    JSON.stringify(synced.map((s) => s.plaintext)),
  );

  await bob.connectWs();
  bob.clearEvents();
  await alice.markRead(synced[0].id);
  await new Promise((r) => setTimeout(r, 150));
  check('Bob received a live read-receipt over WebSocket', bob.state.events.some((e) => e.type === 'read_receipt' && e.messageId === synced[0].id));

  alice.clearEvents();
  bob.clearEvents();
  const reply = await alice.sendMessage(conversationId, 'Yes, I am here now!');
  check("Alice's reply was marked delivered immediately (Bob is connected)", reply.delivered === true);
  await new Promise((r) => setTimeout(r, 150));
  const liveMsgEvent = bob.state.events.find((e) => e.type === 'message');
  check('Bob received the reply live over WebSocket (no polling needed)', !!liveMsgEvent);
  if (liveMsgEvent) {
    const decrypted = await bob.decryptOne(conversationId, liveMsgEvent);
    check('The live-delivered message decrypts correctly', decrypted === 'Yes, I am here now!', decrypted);
  }

  bob.clearEvents();
  alice.sendTyping(conversationId, true);
  await new Promise((r) => setTimeout(r, 150));
  check('Bob received Alice\'s typing event live', bob.state.events.some((e) => e.type === 'typing' && e.isTyping === true));

  let tamperThrew = false;
  try {
    const aad = Engine.buildAad(conversationId, bob.state.recvStep);
    await Engine.ratchetDecrypt(bob.state.session.receivingChainKey, { ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', iv: 'AAAAAAAAAAAAAAAAAAAAAAAA' }, aad);
  } catch { tamperThrew = true; }
  check('Tampered/garbage ciphertext is rejected, not silently decrypted', tamperThrew);

  await bob.blockConversation(conversationId);
  let blockedMsg = null;
  try { await alice.sendMessage(conversationId, 'can you still see this?'); } catch (e) { blockedMsg = e.message; }
  check("After Bob blocks, the server itself rejects Alice's send (not just hidden client-side)", blockedMsg && blockedMsg.includes('403'), blockedMsg);

  server.close();
  plog(`\n${results.filter((r) => r.pass).length}/${results.length} checks passed.`);
  const failed = results.filter((r) => !r.pass);
  if (failed.length) plog(`FAILED: ${JSON.stringify(failed.map((r) => r.label))}`);
  // Explicit exit, not relying on natural process termination: Node's
  // server.close() stops accepting new connections but does not forcibly
  // close already-open keep-alive sockets, so without this the event loop
  // can sit open indefinitely even though all the actual work above is
  // long finished — a real gotcha discovered by hitting it in this session.
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('SCENARIO CRASHED:', e);
  process.exit(1);
});
