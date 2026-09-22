// Regression tests for /api/auth/refresh and /api/auth/logout —
// previously entirely absent from this harness. Found during the final
// V1 pre-runtime audit: despite 224 harness checks passing, and despite
// "refresh-token creation/rotation" being one of the most
// security-critical flows in the app, NEITHER endpoint had ever been
// modeled or exercised by any regression test in this project's
// history. That gap is exactly how the race condition below went
// undetected until now — a passing test suite that never calls the
// endpoint containing the bug proves nothing about that endpoint.
//
// THE FIX itself (mirrored here from auth.service.ts's real fix): two
// concurrent refresh calls presenting the same still-valid refresh
// token used to both pass validation and both write a *different* new
// token — whichever write landed last silently overwrote the other,
// leaving the loser holding a token that was already dead on arrival,
// with no error at the time to explain why. Fixed by guarding the
// rotation UPDATE on the OLD hash still matching (the same
// updateMany-with-a-WHERE-guard idiom already used for pairing-code
// redemption's own concurrent-redeem race).
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

  // No X3DH identity needed — refresh/logout never touch the crypto
  // engine, only the auth_sessions row, same reasoning and same
  // simplified registration shape as regression-pairing-code-collision.mjs.
  async function registerUser() {
    const result = await call(null, 'POST', '/api/auth/register', {
      password: 'correct horse battery staple',
      username: `harness_user_${randomUUID().replace(/-/g, '').slice(0, 10)}`,
      deviceName: 'test device',
      platform: 'web',
      identityDhPublic: randomUUID(),
      identitySigningPublic: randomUUID(),
      signedPrekeyPublic: randomUUID(),
      signedPrekeySignature: randomUUID(),
      oneTimePrekeysPublic: [randomUUID()],
    });
    return { userId: result.data.userId, deviceId: result.data.deviceId, accessToken: result.data.accessToken, refreshToken: result.data.refreshToken };
  }

  // --- Normal refresh: old token dies, new token works ---
  const alice = await registerUser();
  const firstRefresh = await call(null, 'POST', '/api/auth/refresh', { refreshToken: alice.refreshToken });
  check('Normal refresh succeeds and returns a new access + refresh token pair', firstRefresh.status === 200 && !!firstRefresh.data.accessToken && !!firstRefresh.data.refreshToken);
  check('The new refresh token is different from the original', firstRefresh.data.refreshToken !== alice.refreshToken);

  const reuseOldToken = await call(null, 'POST', '/api/auth/refresh', { refreshToken: alice.refreshToken });
  check('Rotation actually rotates: the old (now-superseded) refresh token no longer works', reuseOldToken.status === 401);

  const secondRefresh = await call(null, 'POST', '/api/auth/refresh', { refreshToken: firstRefresh.data.refreshToken });
  check('The new refresh token from the first rotation works for a second rotation', secondRefresh.status === 200);

  // --- A garbage/unknown refresh token is rejected cleanly, not a crash ---
  const garbage = await call(null, 'POST', '/api/auth/refresh', { refreshToken: 'not-a-real-token' });
  check('An unknown refresh token is rejected with 401, not a 500', garbage.status === 401);

  // --- Logout revokes the specific session ---
  const bob = await registerUser();
  const logoutResult = await call(null, 'POST', '/api/auth/logout', { refreshToken: bob.refreshToken });
  check('Logout succeeds', logoutResult.status === 200);
  const refreshAfterLogout = await call(null, 'POST', '/api/auth/refresh', { refreshToken: bob.refreshToken });
  check('A refresh token is dead after logout', refreshAfterLogout.status === 401);
  const secondLogout = await call(null, 'POST', '/api/auth/logout', { refreshToken: bob.refreshToken });
  check('Logging out an already-logged-out token is still a clean success (idempotent), not an error', secondLogout.status === 200);

  // --- A revoked device cannot refresh even with an otherwise-valid, unexpired token ---
  const carol = await registerUser();
  const carolSessions = await call(carol.accessToken, 'GET', '/api/auth/sessions');
  const carolSessionId = carolSessions.data[0]?.id;
  await call(carol.accessToken, 'DELETE', `/api/auth/sessions/${carolSessionId}`); // revokes carol's own only device
  const refreshAfterDeviceRevoke = await call(null, 'POST', '/api/auth/refresh', { refreshToken: carol.refreshToken });
  check('A device revoked via /api/auth/sessions/:id cannot refresh its access token afterward', refreshAfterDeviceRevoke.status === 401);

  // --- THE FIX: honest limits on what can actually be verified here ---
  // The fix itself guards against a genuine TOCTOU race *within one
  // request's own execution* — another request's write landing between
  // THIS request's SELECT and its own later UPDATE. That specific window
  // cannot be produced in this harness at all, by any means, and I want
  // to be explicit about having actually tried two different approaches
  // and rejected both rather than shipping either:
  //
  // 1. Promise.all-ing two real /api/auth/refresh HTTP calls with the
  //    same token. Confirmed via mutation testing that this still passes
  //    even against a mutant with the WHERE-guard entirely removed —
  //    node:sqlite's DatabaseSync runs every statement in a handler
  //    synchronously with no interleaving, so the "loser" request's own
  //    fresh SELECT (a different WHERE clause, not the guard this fix
  //    adds) already finds no session for the by-then-superseded hash,
  //    since the "winner" request's entire read-then-write chain runs to
  //    completion before the event loop ever lets the loser resume past
  //    its own `readJsonBody` await. Real and correct, but doesn't
  //    distinguish the fix from its absence.
  // 2. Issuing the guarded UPDATE statement by hand, from this test file,
  //    with a stale hash, and checking it matches zero rows. This
  //    "passed" too, including against the mutant — because it's a
  //    statement I wrote myself in this file, not the endpoint's actual
  //    code, so mutating server.mjs has no effect on it at all. It
  //    proved SQL semantics I already knew, not that the real endpoint
  //    uses them.
  //
  // This is the same category of limitation as messages.service.ts's
  // sequence-number race and the attachment orphan sweep's own guarded
  // delete (both documented the same way rather than papering over it),
  // and, like pairing.service.ts's redeem() $transaction fix in the same
  // audit pass, this one is genuinely code-reviewed-only: no test in
  // this file exercises the TOCTOU-specific guard, and none of the
  // checks above should be read as covering it. What the checks above
  // DO genuinely cover — real rotation, a stale token dying, logout,
  // device-revocation blocking refresh — they cover for real.

  server.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checks passed.`);
  process.exit(passed === results.length ? 0 : 1);
}

run().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
