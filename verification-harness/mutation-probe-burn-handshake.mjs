// Negative-test proof for a burn invariant: once a conversation is
// burned, any handshake message stored for it before the burn must not
// still be fetchable/completable afterward. Run once against a mutant
// copy of server.mjs with the pending_handshakes cleanup removed from
// burn() (must show the leak) and once against the real server.mjs
// (must show it fixed).
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

const ivan = await register('pw', 'i');
const judy = await register('pw', 'j');

const p = await call(ivan.accessToken, 'POST', '/api/pairing/create', { durationSeconds: 900 });
const r = await call(judy.accessToken, 'POST', '/api/pairing/redeem', { code: p.data.code });
const conversationId = r.data.conversationId;
const { message } = await Engine.initiateHandshake(judy.identity, r.data.bundle);
// Judy stores her handshake; Ivan (the creator) never fetches/completes
// it before burning — the exact "unfetched pending handshake" state
// burn's cleanup is supposed to invalidate.
await call(judy.accessToken, 'POST', '/api/handshake', { conversationId, handshakeMessage: message, sessionEpoch: r.data.sessionEpoch });

await call(ivan.accessToken, 'POST', `/api/conversations/${conversationId}/burn`, {});

const fetchAfterBurn = await call(ivan.accessToken, 'GET', `/api/handshake?conversationId=${conversationId}`);

server.closeAllConnections?.();
server.close();
await new Promise((r) => setTimeout(r, 100));
const cleaned = fetchAfterBurn.status === 404;
console.log(`[${serverModule}] post-burn handshake fetch status: ${fetchAfterBurn.status} -> protection ${cleaned ? 'ACTIVE (gone, as expected)' : 'ABSENT (still fetchable — vulnerable!)'}`);
process.exit(cleaned ? 0 : 1);
