// Negative-test proof: pairing-code guessing must become locked out after
// enough wrong attempts. Run once against a mutant with the lockout
// tracking removed (must show unlimited guessing) and once against the
// real server.mjs (must show it locked down).
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

const karen = await register('pw', 'k');
const larry = await register('pw', 'l');
const p = await call(karen.accessToken, 'POST', '/api/pairing/create', { durationSeconds: 900 });

for (let i = 0; i < 10; i++) {
  await call(larry.accessToken, 'POST', '/api/pairing/redeem', { code: '000000' });
}
const correctAttempt = await call(larry.accessToken, 'POST', '/api/pairing/redeem', { code: p.data.code });

const locked = correctAttempt.status === 400;
console.log(`[${serverModule}] correct code after 10 wrong guesses: ${correctAttempt.status} -> lockout ${locked ? 'ACTIVE (correctly rejected)' : 'ABSENT (accepted — unlimited brute force possible!)'}`);
server.closeAllConnections?.();
server.close();
await new Promise((r) => setTimeout(r, 100));
process.exit(locked ? 0 : 1);
