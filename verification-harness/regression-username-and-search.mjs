// Regression tests for the username feature: required-unique usernames
// on registration, the pre-registration availability check, and
// authenticated exact-match username search gated by each account's own
// usernameSearchEnabled privacy setting (plus existing block semantics).
//
// Run against verification-harness/server.mjs, the same hand-rolled
// HTTP+node:sqlite stand-in for the real NestJS+Prisma+Postgres backend
// every other regression-*.mjs file here uses (see server.mjs's own
// header comment for why: no reachable Postgres / Prisma engine
// download in this sandbox). The validation itself is NOT
// reimplemented here — server.mjs imports normalizeUsername/
// validateUsername directly from the real
// apps/backend/src/domain/username.ts, the same file
// RegisterDto/UsernameAvailabilityDto/SearchUsernameDto's @IsUsername()
// decorator calls in the actual NestJS app — so a policy change in one
// place can't silently drift from what's tested here.
//
// What this does NOT prove: that AuthController/UsersController/
// AuthService/UsersService's own NestJS wiring (DI, the ValidationPipe,
// the Prisma query shapes) behaves identically — that would need the
// real stack running, which this sandbox cannot reach (see the
// project's README and this feature's own final report for specifics
// on the Prisma engine binary download being blocked here). The Prisma
// migration itself (nullable -> backfill -> NOT NULL -> UNIQUE) was
// instead verified directly against a real local Postgres with psql;
// see the final report.
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

  // No real X3DH identity needed — none of this touches the crypto
  // engine, only the auth/users/settings routes — matching the same
  // simplified registration pattern already established in
  // regression-pairing-code-collision.mjs / regression-refresh-logout.mjs.
  async function registerRaw(body) {
    return call(null, 'POST', '/api/auth/register', {
      password: 'correct horse battery staple',
      deviceName: 'test device',
      platform: 'web',
      identityDhPublic: randomUUID(),
      identitySigningPublic: randomUUID(),
      signedPrekeyPublic: randomUUID(),
      signedPrekeySignature: randomUUID(),
      oneTimePrekeysPublic: [randomUUID()],
      ...body,
    });
  }
  async function registerUser(username) {
    const result = await registerRaw({ username });
    return { userId: result.data.userId, accessToken: result.data.accessToken, data: result.data };
  }

  // ---- 1. registration without username -> rejected ----
  {
    const r = await registerRaw({});
    check('Registration without username is rejected', r.status === 400, `status=${r.status}`);
  }

  // ---- 2. valid username -> accepted, returned in the response ----
  {
    const r = await registerRaw({ username: 'anuraaag12' });
    check('A valid username is accepted (201)', r.status === 201, `status=${r.status}`);
    check('Register response includes the username', r.data.username === 'anuraaag12', `got ${r.data.username}`);
  }

  // ---- 3. normalization: mixed case + surrounding whitespace -> stored/returned lowercase ----
  {
    const r = await registerRaw({ username: '  AnuraaaG34  ' });
    check('Registration accepts mixed-case/whitespace input', r.status === 201, `status=${r.status}`);
    check('Username is normalized to lowercase on the way in', r.data.username === 'anuraaag34', `got ${r.data.username}`);
  }

  // ---- 4/7/8/9/10/11: invalid usernames are rejected, none of them create an account ----
  const invalidCases = [
    ['an', 'too short'],
    ['@anuraaag12', 'contains @'],
    ['Anurag 12', 'contains a space'],
    ['_anurag', 'leading underscore'],
    ['anurag_', 'trailing underscore'],
    ['anurag__12', 'consecutive underscores'],
    ['anurag-12', 'hyphen not allowed'],
    ['1anurag', 'starts with a digit'],
    ['a'.repeat(31), 'too long'],
  ];
  for (const [username, why] of invalidCases) {
    const r = await registerRaw({ username });
    check(`Invalid username rejected: ${why}`, r.status === 400, `username=${JSON.stringify(username)} status=${r.status}`);
  }

  // ---- 5/6: duplicate + case-insensitive duplicate -> rejected ----
  {
    const first = await registerRaw({ username: 'pookiechat' });
    check('First registration of a fresh username succeeds', first.status === 201);
    const dup = await registerRaw({ username: 'pookiechat' });
    check('Exact duplicate username is rejected (409)', dup.status === 409, `status=${dup.status}`);
    const dupCase = await registerRaw({ username: 'PookieChat' });
    check('Case-insensitive duplicate username is rejected (409)', dupCase.status === 409, `status=${dupCase.status}`);
  }

  // ---- 12: concurrent duplicate registration -> only one succeeds ----
  {
    const racingUsername = 'racecondition_' + randomUUID().replace(/-/g, '').slice(0, 8);
    const [a, b] = await Promise.all([registerRaw({ username: racingUsername }), registerRaw({ username: racingUsername })]);
    const statuses = [a.status, b.status].sort();
    check(
      'Concurrent identical registrations: exactly one 201 and one 409, never both 201',
      statuses[0] === 201 && statuses[1] === 409,
      `statuses=${JSON.stringify([a.status, b.status])}`,
    );
  }

  // ---- Availability check endpoint ----
  {
    const taken = await call(null, 'GET', '/api/auth/username-availability?username=pookiechat');
    check('Availability check reports a taken username as unavailable', taken.data.available === false, JSON.stringify(taken.data));
    const free = await call(null, 'GET', `/api/auth/username-availability?username=totally_free_${randomUUID().replace(/-/g, '').slice(0, 6)}`);
    check('Availability check reports a fresh username as available', free.data.available === true, JSON.stringify(free.data));
    const invalid = await call(null, 'GET', '/api/auth/username-availability?username=@bad');
    check('Availability check reports an invalid username as unavailable rather than erroring', invalid.status === 200 && invalid.data.available === false);
  }

  // ---- 15 (login/session response includes username) ----
  {
    const reg = await registerUser('loginshowsusername');
    const login = await call(null, 'POST', '/api/auth/login', {
      userId: reg.userId,
      password: 'correct horse battery staple',
      deviceName: 'second device',
      platform: 'web',
      identityDhPublic: randomUUID(),
      identitySigningPublic: randomUUID(),
      signedPrekeyPublic: randomUUID(),
      signedPrekeySignature: randomUUID(),
      oneTimePrekeysPublic: [randomUUID()],
    });
    check('Login response includes username', login.data.username === 'loginshowsusername', JSON.stringify(login.data.username));
  }

  // ---- Search: setup two accounts ----
  const alice = await registerUser('alice_' + randomUUID().replace(/-/g, '').slice(0, 8));
  const bob = await registerUser('bob_' + randomUUID().replace(/-/g, '').slice(0, 8));

  // ---- 18 (unauthenticated search -> rejected) ----
  {
    const r = await call(null, 'GET', `/api/users/search?username=${alice.data.username}`);
    check('Unauthenticated search is rejected (401)', r.status === 401, `status=${r.status}`);
  }

  // ---- 14/15: authenticated exact-match search finds a discoverable public user ----
  {
    const r = await call(bob.accessToken, 'GET', `/api/users/search?username=${alice.data.username}`);
    check('Authenticated search finds a discoverable username', r.status === 200 && r.data.user?.username === alice.data.username, JSON.stringify(r.data));
    check(
      'Search response exposes only username + displayName — no email, passwordHash, or internal id',
      r.data.user && Object.keys(r.data.user).sort().join(',') === 'displayName,username',
      JSON.stringify(r.data.user),
    );
  }

  // ---- 16 (case-insensitive search still finds the exact account) ----
  {
    const r = await call(bob.accessToken, 'GET', `/api/users/search?username=${alice.data.username.toUpperCase()}`);
    check('Search normalizes the query the same way registration does (case-insensitive match)', r.data.user?.username === alice.data.username);
  }

  // ---- 17 (nonexistent username -> generic not-found) ----
  {
    const r = await call(bob.accessToken, 'GET', `/api/users/search?username=nobody_by_this_name_zzz`);
    check('Nonexistent username returns { user: null }, not an error', r.status === 200 && r.data.user === null, JSON.stringify(r.data));
  }

  // ---- 23 (self-search) ----
  {
    const r = await call(alice.accessToken, 'GET', `/api/users/search?username=${alice.data.username}`);
    check('Self-search finds the account', r.data.user?.username === alice.data.username);
    check('Self-search is flagged distinctly (isSelf), not a plain miss or a normal result', r.data.isSelf === true, JSON.stringify(r.data));
  }

  // ---- 21 (usernameSearchEnabled defaults to true) ----
  {
    const r = await call(alice.accessToken, 'GET', '/api/settings');
    check('usernameSearchEnabled defaults to true for a fresh account', r.data.usernameSearchEnabled === true, JSON.stringify(r.data));
  }

  // ---- 24/25/26/27/28: disabling discovery hides the user; re-enabling restores it; stale results aren't trusted ----
  {
    const disable = await call(alice.accessToken, 'PATCH', '/api/settings', { usernameSearchEnabled: false });
    check('Disabling username search succeeds', disable.status === 200 && disable.data.usernameSearchEnabled === false, JSON.stringify(disable.data));

    const hidden = await call(bob.accessToken, 'GET', `/api/users/search?username=${alice.data.username}`);
    check(
      '17/18 (private): a disabled account disappears from search — SAME generic { user: null } as a nonexistent username, not a distinguishable "exists but private" response',
      hidden.status === 200 && hidden.data.user === null,
      JSON.stringify(hidden.data),
    );

    // "Stale search result cannot bypass a newly-disabled privacy
    // setting" in this codebase's actual architecture (no
    // direct-by-userId chat-start endpoint exists — see the feature's
    // final report on why "Start Chat" routes into the existing pairing
    // flow instead of a new one) means: re-running the SAME search
    // endpoint immediately before acting on a result — rather than
    // trusting an earlier response — is exactly what re-confirms
    // current state. This checks that re-query, live, actually reflects
    // the change made a moment ago rather than some cached/stale view.
    const reconfirm = await call(bob.accessToken, 'GET', `/api/users/search?username=${alice.data.username}`);
    check('Re-querying search again (simulating "confirm before starting a chat") still reflects the live, current privacy state', reconfirm.data.user === null);

    const reenable = await call(alice.accessToken, 'PATCH', '/api/settings', { usernameSearchEnabled: true });
    check('Re-enabling username search succeeds', reenable.data.usernameSearchEnabled === true);
    const visibleAgain = await call(bob.accessToken, 'GET', `/api/users/search?username=${alice.data.username}`);
    check('28: re-enabling makes the account searchable again', visibleAgain.data.user?.username === alice.data.username, JSON.stringify(visibleAgain.data));
  }

  // ---- 29/31/33: existing conversations and E2EE/session state are untouched by a privacy toggle ----
  {
    const carol = await registerUser('carol_' + randomUUID().replace(/-/g, '').slice(0, 8));
    const dave = await registerUser('dave_' + randomUUID().replace(/-/g, '').slice(0, 8));
    const pairing = await call(carol.accessToken, 'POST', '/api/pairing/create', { durationSeconds: 900 });
    const redeemed = await call(dave.accessToken, 'POST', '/api/pairing/redeem', { code: pairing.data.code });
    const conversationId = redeemed.data.conversationId;
    check('Setup: Carol and Dave have an existing conversation', !!conversationId);

    await call(carol.accessToken, 'PATCH', '/api/settings', { usernameSearchEnabled: false });
    // Proves the conversation itself is untouched by the toggle: sending
    // a real message on it still succeeds exactly as before (there is
    // no GET /api/conversations in this harness to list rows from
    // directly — the real proof of "the conversation still works" is
    // that it still accepts a message, not that some listing endpoint
    // happens to include it).
    const stillWorks = await call(dave.accessToken, 'POST', '/api/messages', {
      conversationId,
      clientMessageId: randomUUID(),
      ciphertext: 'not-real-ciphertext-username-feature-does-not-care',
      iv: 'AAAAAAAAAAAAAAAA',
      messageType: 'TEXT',
      sessionEpoch: 1,
    });
    check(
      '31: an existing conversation keeps working after the other party disables username search',
      stillWorks.status === 201,
      `status=${stillWorks.status} body=${JSON.stringify(stillWorks.data)}`,
    );

    // ---- 24/26/33: existing block semantics are respected by search ----
    const eve = await registerUser('eve_' + randomUUID().replace(/-/g, '').slice(0, 8));
    const frank = await registerUser('frank_' + randomUUID().replace(/-/g, '').slice(0, 8));
    const efPairing = await call(eve.accessToken, 'POST', '/api/pairing/create', { durationSeconds: 900 });
    const efRedeemed = await call(frank.accessToken, 'POST', '/api/pairing/redeem', { code: efPairing.data.code });
    const efConversationId = efRedeemed.data.conversationId;
    await call(eve.accessToken, 'POST', `/api/conversations/${efConversationId}/block`, {});
    const blockedSearch = await call(frank.accessToken, 'GET', `/api/users/search?username=${eve.data.username}`);
    check(
      '26/33: a blocked counterpart does not resurface via username search, even though usernameSearchEnabled is still true',
      blockedSearch.data.user === null,
      JSON.stringify(blockedSearch.data),
    );
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
