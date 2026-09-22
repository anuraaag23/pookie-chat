// Negative-test proof for the core invariant: a message send claiming a
// superseded (stale) sessionEpoch must be rejected. Run once against a
// mutant copy of server.mjs with the check disabled (must FAIL, proving
// the test actually exercises the protection) and once against the real
// server.mjs (must PASS, proving the protection is active). Deletes the
// mutant when done either way.
import { randomUUID } from 'node:crypto';

const serverModule = process.argv[2]; // './server.mjs' or './server.mutant1.mjs'
const { createHarness } = await import(serverModule);
const Engine = await import('../apps/web/lib/crypto/engine.ts');

const { server } = createHarness();
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

async function register(password, deviceName) {
  const identity = await Engine.generateDeviceIdentity(5);
  const bundle = Engine.toPublicBundle(identity);
  const username = `harness_${deviceName.toLowerCase().replace(/[^a-z0-9]/g, '') || 'u'}_${Math.random().toString(36).slice(2, 8)}`;
  const result = await call(null, 'POST', '/api/auth/register', { password, username, deviceName, platform: 'web', ...bundle, oneTimePrekeysPublic: identity.oneTimePrekeysPublic });
  return { identity, ...result.data };
}

const alice = await register('pw', 'a');
const bob = await register('pw', 'b');

const p1 = await call(alice.accessToken, 'POST', '/api/pairing/create', { durationSeconds: 900 });
const r1 = await call(bob.accessToken, 'POST', '/api/pairing/redeem', { code: p1.data.code });
const conversationId = r1.data.conversationId;
const { session: bobSession, message } = await Engine.initiateHandshake(bob.identity, r1.data.bundle);
await call(bob.accessToken, 'POST', '/api/handshake', { conversationId, handshakeMessage: message, sessionEpoch: r1.data.sessionEpoch });
const fetched = await call(alice.accessToken, 'GET', `/api/handshake?conversationId=${conversationId}`);
await Engine.completeHandshake(alice.identity, fetched.data.handshakeMessage);

// Burn, then re-pair — this is the epoch-1-becomes-stale moment.
await call(alice.accessToken, 'POST', `/api/conversations/${conversationId}/burn`, {});
const p2 = await call(alice.accessToken, 'POST', '/api/pairing/create', { durationSeconds: 900 });
await call(bob.accessToken, 'POST', '/api/pairing/redeem', { code: p2.data.code }); // bumps epoch to 2; bob's OWN client-side session var here deliberately not updated, simulating a device that missed this

// Bob's OLD session (epoch 1) tries to send into the now-epoch-2 conversation.
const aad = Engine.buildAad(conversationId, 0);
const { envelope } = await Engine.ratchetEncrypt(bobSession.sendingChainKey, 'stale message', aad);
const staleSend = await call(bob.accessToken, 'POST', '/api/messages', {
  conversationId,
  clientMessageId: randomUUID(),
  ciphertext: envelope.ciphertext,
  iv: envelope.iv,
  messageType: 'TEXT',
  sessionEpoch: 1, // still claiming the pre-burn epoch
});

server.closeAllConnections?.();
server.close();
await new Promise((r) => setTimeout(r, 100));
const rejected = staleSend.status === 409;
console.log(`[${serverModule}] stale-epoch send status: ${staleSend.status} -> protection ${rejected ? 'ACTIVE (rejected, as expected)' : 'ABSENT (accepted — vulnerable!)'}`);
process.exit(rejected ? 0 : 1);
