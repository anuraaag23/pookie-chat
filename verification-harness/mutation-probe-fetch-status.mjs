// Negative-test proof for a distinct invariant from the epoch check:
// once a conversation is BLOCKED (not burned — blocking touches neither
// pending_handshakes nor sessionEpoch, unlike burn/re-pair), a handshake
// stored before the block must not still be fetchable/completable. This
// isolates HandshakeService.fetch's status check specifically — burn's
// own pending_handshakes cleanup and the epoch check are both
// deliberately kept out of play by using block instead of burn, so a
// pass here cannot be explained by either of those other protections.
const serverModule = process.argv[2];
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

const p = await call(alice.accessToken, 'POST', '/api/pairing/create', { durationSeconds: 900 });
const r = await call(bob.accessToken, 'POST', '/api/pairing/redeem', { code: p.data.code });
const conversationId = r.data.conversationId;
const { message } = await Engine.initiateHandshake(bob.identity, r.data.bundle);
// Bob stores his handshake; Alice (the creator) never fetches it before
// Bob blocks her.
await call(bob.accessToken, 'POST', '/api/handshake', { conversationId, handshakeMessage: message, sessionEpoch: r.data.sessionEpoch });
await call(bob.accessToken, 'POST', `/api/conversations/${conversationId}/block`, {});

const fetchWhileBlocked = await call(alice.accessToken, 'GET', `/api/handshake?conversationId=${conversationId}`);

server.closeAllConnections?.();
server.close();
await new Promise((r) => setTimeout(r, 100));
const rejected = fetchWhileBlocked.status === 404;
console.log(`[${serverModule}] handshake fetch while blocked status: ${fetchWhileBlocked.status} -> protection ${rejected ? 'ACTIVE (rejected, as expected)' : 'ABSENT (still completable while blocked — vulnerable!)'}`);
process.exit(rejected ? 0 : 1);
