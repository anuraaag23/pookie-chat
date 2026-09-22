// Regression tests for PATCH /api/auth/username: normal change, the
// 365-day cooldown, and that the cooldown/uniqueness/self-check happen
// server-side regardless of what a client already believes.
import { createHarness } from './server.mjs';
import { randomUUID } from 'node:crypto';

const results = [];
function check(label, cond, detail = '') {
  results.push(!!cond);
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${label}${detail ? ' (' + detail + ')' : ''}`);
}

async function run() {
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

  async function registerUser(username) {
    const result = await call(null, 'POST', '/api/auth/register', {
      password: 'correct horse battery staple',
      username,
      deviceName: 'test device',
      platform: 'web',
      identityDhPublic: randomUUID(),
      identitySigningPublic: randomUUID(),
      signedPrekeyPublic: randomUUID(),
      signedPrekeySignature: randomUUID(),
      oneTimePrekeysPublic: [randomUUID()],
    });
    return { userId: result.data.userId, accessToken: result.data.accessToken, data: result.data };
  }

  // ---- unauthenticated -> rejected ----
  {
    const r = await call(null, 'PATCH', '/api/auth/username', { username: 'somebody' });
    check('Unauthenticated username-change request is rejected (401)', r.status === 401, `status=${r.status}`);
  }

  // ---- register response has nextUsernameChangeAllowedAt: null (never changed) ----
  const alice = await registerUser('alice_' + randomUUID().replace(/-/g, '').slice(0, 8));
  check('A fresh registration has no cooldown (nextUsernameChangeAllowedAt is null)', alice.data.nextUsernameChangeAllowedAt === null, JSON.stringify(alice.data.nextUsernameChangeAllowedAt));

  // ---- first change succeeds ----
  const newName = 'alice_renamed_' + randomUUID().replace(/-/g, '').slice(0, 6);
  {
    const r = await call(alice.accessToken, 'PATCH', '/api/auth/username', { username: newName });
    check('First username change succeeds (200)', r.status === 200, `status=${r.status} body=${JSON.stringify(r.data)}`);
    check('Response reflects the new username', r.data.username === newName, r.data.username);
    check('Response now carries a future nextUsernameChangeAllowedAt', typeof r.data.nextUsernameChangeAllowedAt === 'string' && new Date(r.data.nextUsernameChangeAllowedAt) > new Date());
  }

  // ---- immediately trying again is blocked by the cooldown ----
  {
    const r = await call(alice.accessToken, 'PATCH', '/api/auth/username', { username: 'alice_again_' + randomUUID().replace(/-/g, '').slice(0, 6) });
    check('A second change within 365 days is rejected (403)', r.status === 403, `status=${r.status} body=${JSON.stringify(r.data)}`);
    check('Cooldown rejection carries the actual next-allowed date, not just prose', typeof r.data.nextUsernameChangeAllowedAt === 'string');
    // Confirm it did NOT change despite the rejected attempt.
    const search = await call(alice.accessToken, 'GET', `/api/users/search?username=${newName}`);
    check('Username is unchanged after a cooldown-rejected attempt (self-search still finds the post-first-change name)', search.data.user?.username === newName, JSON.stringify(search.data));
  }

  // ---- changing to your own current username is rejected distinctly ----
  {
    const r = await call(alice.accessToken, 'PATCH', '/api/auth/username', { username: newName });
    check('Changing to your own current username is rejected (409), not silently accepted', r.status === 409, `status=${r.status}`);
  }

  // ---- changing to a name someone else already has is rejected ----
  const bob = await registerUser('bob_' + randomUUID().replace(/-/g, '').slice(0, 8));
  {
    const r = await call(bob.accessToken, 'PATCH', '/api/auth/username', { username: newName });
    check('Changing to a username someone else already holds is rejected (409)', r.status === 409, `status=${r.status}`);
  }

  // ---- invalid new username is rejected ----
  {
    const r = await call(bob.accessToken, 'PATCH', '/api/auth/username', { username: '@bad name' });
    check('An invalid new username is rejected (400)', r.status === 400, `status=${r.status}`);
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checks passed.`);
  server.close();
  process.exit(passed === results.length ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
