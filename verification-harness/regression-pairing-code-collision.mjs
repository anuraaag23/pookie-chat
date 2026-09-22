// Regression tests for THE FIX found during the final V1 pre-runtime
// audit: a pairing code is only a 6-digit string — 1,000,000 possible
// values (docs/01-THREAT-MODEL.md accepts this keyspace deliberately,
// relying on short lifetimes, single use, and rate limiting rather than
// size). PairingCode.@@unique([codeHmac, status]) means two different
// users generating the identical 6-digit code while both codes are
// simultaneously ACTIVE hit a real database constraint violation on the
// *second* create() — through no fault of either user. Before this fix,
// pairing.service.ts's create() had no handling for that at all: an
// ordinary, legitimate request would 500. Fixed by retrying with a
// freshly generated code on that specific conflict, reusing the exact
// same retryOnUniqueConflict control flow already proven correct (see
// regression-sync-fix.mjs) for messages.service.ts's sequence-number
// race.
//
// Important honesty note about what these checks actually prove: the
// checks below that call retryOnUniqueConflict directly prove the real
// SQL statement and the real UNIQUE(code_hmac, status) constraint on
// this specific table genuinely trigger the shared retry path when
// driven through it — they do NOT, on their own, prove
// /api/pairing/create's handler actually calls that path, since
// generatePairingCode() is CSPRNG-based (no test hook, deliberately —
// this is real security-relevant code, not something to add a
// test-only bypass to) and can't be forced to collide through genuine
// random generation inside a fast, deterministic test. Confirmed this
// gap for real: an earlier draft of this file passed 8/8 even against a
// mutant server.mjs with the endpoint's retry call removed entirely,
// because every check exercised retryOnUniqueConflict directly rather
// than the endpoint. The explicit static wiring check below (reading
// the endpoint's own source rather than driving it dynamically) is what
// actually closes that gap — confirmed by re-running the same mutant
// afterward and seeing exactly that check, and only that check, fail.
import { createHarness, retryOnUniqueConflict } from './server.mjs';
import { hashPairingCode } from '../apps/backend/src/domain/pairingCode.ts';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const results = [];
function check(label, cond, detail = '') {
  results.push(!!cond);
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${label}${detail ? ' (' + detail + ')' : ''}`);
}

const PEPPER = process.env.HARNESS_PAIRING_PEPPER || 'harness-dev-pepper-not-for-real-use';

async function run() {
  const { server, db } = createHarness();
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

  // No X3DH identity needed for this file — pairing-code creation itself
  // doesn't touch the crypto engine, only /api/pairing/create's own DB
  // path — so registration is stubbed down to the minimum register() needs.
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
    return { userId: result.data.userId, accessToken: result.data.accessToken };
  }

  // The exact insert the real /api/pairing/create handler uses, isolated
  // here so it can be driven with a controlled (not genuinely random)
  // sequence of codes — this is what makes a real collision reproducible
  // on demand instead of waiting on a 1-in-a-million chance.
  function insertPairingCode(creatorUserId, code) {
    const id = randomUUID();
    db.prepare('INSERT INTO pairing_codes (id, creator_user_id, code_hmac, expires_at) VALUES (?, ?, ?, ?)').run(
      id,
      creatorUserId,
      hashPairingCode(code, PEPPER),
      null,
    );
    return { pairingId: id, code };
  }

  const alice = await registerUser();

  // --- Force a genuine collision and confirm it's retried, not thrown ---
  const collidingCode = '123456';
  insertPairingCode(alice.userId, collidingCode); // pre-existing ACTIVE row occupying this exact (codeHmac, 'ACTIVE') pair

  const codeSequence = [collidingCode, collidingCode, '789012']; // two more redundant collisions, then a fresh one
  let callCount = 0;
  const result = await retryOnUniqueConflict(() => {
    const code = codeSequence[callCount];
    callCount += 1;
    return insertPairingCode(alice.userId, code);
  }, 5);

  check('THE FIX: a genuine (codeHmac, status) collision is retried rather than thrown', result.code === '789012');
  check('THE FIX: retrying actually happened — took exactly 3 attempts (2 collisions + 1 success), not fewer or more', callCount === 3, `callCount=${callCount}`);

  const rows = db.prepare('SELECT code_hmac FROM pairing_codes WHERE creator_user_id = ?').all(alice.userId);
  check('Exactly two rows exist afterward: the original pre-seeded one and the one successful retry', rows.length === 2, `rows=${rows.length}`);
  check(
    'The pre-seeded conflicting row is completely untouched by the retry',
    rows.some((r) => r.code_hmac === hashPairingCode(collidingCode, PEPPER)),
  );
  check(
    'The retry landed with the actually-different code, not a further collision',
    rows.some((r) => r.code_hmac === hashPairingCode('789012', PEPPER)),
  );

  // --- Gives up cleanly after maxAttempts if every attempt collides ---
  const bob = await registerUser();
  const alwaysCollidingCode = '111111';
  insertPairingCode(bob.userId, alwaysCollidingCode);
  let giveUpAttempts = 0;
  let threwAsExpected = false;
  try {
    await retryOnUniqueConflict(() => {
      giveUpAttempts += 1;
      return insertPairingCode(bob.userId, alwaysCollidingCode); // every attempt collides with itself
    }, 3);
  } catch {
    threwAsExpected = true;
  }
  check('Gives up (throws) after maxAttempts if every attempt genuinely collides, rather than looping forever', threwAsExpected);
  check('Made exactly maxAttempts attempts before giving up, not more', giveUpAttempts === 3, `giveUpAttempts=${giveUpAttempts}`);

  // --- The ordinary, non-colliding path through the real HTTP endpoint is unaffected ---
  const carol = await registerUser();
  const normalCreate = await call(carol.accessToken, 'POST', '/api/pairing/create', { durationSeconds: 900 });
  check('Ordinary pairing-code creation (no collision) still returns 201 with a usable code', normalCreate.status === 201 && /^\d{6}$/.test(normalCreate.data.code ?? ''));

  // --- Static wiring check: the endpoint itself actually calls the retry path ---
  // See the file header comment for why this is necessary and not
  // redundant with the checks above: generatePairingCode()'s real CSPRNG
  // can't be forced to collide inside a fast, deterministic test without
  // a test-only hook this security-relevant function deliberately
  // doesn't have, so nothing above actually drives a collision through
  // the endpoint itself. This reads server.mjs's own source rather than
  // its behavior — it exists to catch someone reverting the endpoint's
  // wiring back to a bare insert while leaving retryOnUniqueConflict
  // itself untouched (which every check above would still pass).
  const serverSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'server.mjs'), 'utf8');
  const pairingCreateHandlerMatch = serverSource.match(/\/api\/pairing\/create'\) \{[\s\S]*?\n {6}\}/);
  check(
    "Static check: the /api/pairing/create handler's own source actually calls retryOnUniqueConflict",
    !!pairingCreateHandlerMatch && pairingCreateHandlerMatch[0].includes('retryOnUniqueConflict'),
  );

  server.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checks passed.`);
  process.exit(passed === results.length ? 0 : 1);
}

run().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
