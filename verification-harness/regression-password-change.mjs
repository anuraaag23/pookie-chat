// Regression tests for PATCH /api/auth/password: a valid access token
// alone must never be sufficient to change the account password — the
// current password itself must be verified server-side (see
// AuthService.changePassword's own comment on why an access token
// proves something different from "still has the password").
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

  const ORIGINAL_PASSWORD = 'original horse battery staple';
  async function registerUser() {
    const result = await call(null, 'POST', '/api/auth/register', {
      password: ORIGINAL_PASSWORD,
      username: `harness_pwtest_${randomUUID().replace(/-/g, '').slice(0, 8)}`,
      deviceName: 'test device',
      platform: 'web',
      identityDhPublic: randomUUID(),
      identitySigningPublic: randomUUID(),
      signedPrekeyPublic: randomUUID(),
      signedPrekeySignature: randomUUID(),
      oneTimePrekeysPublic: [randomUUID()],
    });
    return { userId: result.data.userId, accessToken: result.data.accessToken };
  }
  async function canLoginWith(userId, password) {
    const r = await call(null, 'POST', '/api/auth/login', {
      userId,
      password,
      deviceName: 'login-probe',
      platform: 'web',
      identityDhPublic: randomUUID(),
      identitySigningPublic: randomUUID(),
      signedPrekeyPublic: randomUUID(),
      signedPrekeySignature: randomUUID(),
      oneTimePrekeysPublic: [randomUUID()],
    });
    return r.status === 200;
  }

  // ---- unauthenticated request rejected ----
  {
    const r = await call(null, 'PATCH', '/api/auth/password', { currentPassword: 'x', newPassword: 'y'.repeat(8) });
    check('Unauthenticated password-change request is rejected (401)', r.status === 401, `status=${r.status}`);
  }

  // ---- wrong current password: rejected, and the password genuinely does not change ----
  {
    const user = await registerUser();
    const r = await call(user.accessToken, 'PATCH', '/api/auth/password', {
      currentPassword: 'definitely the wrong password',
      newPassword: 'brand-new-password-123',
    });
    check('Wrong current password is rejected even with a valid access token (401)', r.status === 401, `status=${r.status}`);
    check('Password is unchanged after a rejected attempt: original still logs in', await canLoginWith(user.userId, ORIGINAL_PASSWORD));
    check('Password is unchanged after a rejected attempt: the attempted new password does NOT log in', !(await canLoginWith(user.userId, 'brand-new-password-123')));
  }

  // ---- new password too short (7 characters): rejected ----
  {
    const user = await registerUser();
    const r = await call(user.accessToken, 'PATCH', '/api/auth/password', { currentPassword: ORIGINAL_PASSWORD, newPassword: '1234567' });
    check('A new password under the minimum length (7 chars) is rejected (400)', r.status === 400, `status=${r.status}`);
  }

  // ---- new password exactly minimum length (8 characters): accepted ----
  {
    const user = await registerUser();
    const r = await call(user.accessToken, 'PATCH', '/api/auth/password', { currentPassword: ORIGINAL_PASSWORD, newPassword: '8char-pw' });
    check('A new password meeting the minimum length (8 chars) is accepted (200)', r.status === 200, `status=${r.status}`);
    check('User can login with new 8-character password', await canLoginWith(user.userId, '8char-pw'));
  }

  // ---- correct current password: succeeds, and takes effect for real ----
  {
    const user = await registerUser();
    const r = await call(user.accessToken, 'PATCH', '/api/auth/password', {
      currentPassword: ORIGINAL_PASSWORD,
      newPassword: 'a-genuinely-new-password-456',
    });
    check('Correct current password + valid new password succeeds (200)', r.status === 200, `status=${r.status}`);
    check('After a successful change, the OLD password no longer logs in', !(await canLoginWith(user.userId, ORIGINAL_PASSWORD)));
    check('After a successful change, the NEW password does log in', await canLoginWith(user.userId, 'a-genuinely-new-password-456'));
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
