import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../password.ts';
import {
  generatePairingCode,
  hashPairingCode,
  verifyPairingCode,
  computeExpiresAt,
  isExpired,
  recordFailedAttempt,
  isLockedOut,
} from '../pairingCode.ts';
import {
  issueAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken,
} from '../tokens.ts';

// ---- password.ts ----
test('password: correct password verifies, wrong password fails', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.equal(await verifyPassword('correct horse battery staple', hash), true);
  assert.equal(await verifyPassword('wrong password', hash), false);
});

test('password: never stores/returns the plaintext, and salts differ per hash', async () => {
  const h1 = await hashPassword('same-password');
  const h2 = await hashPassword('same-password');
  assert.notEqual(h1, h2, 'two hashes of the same password must differ (different salts)');
  assert.equal(h1.includes('same-password'), false);
});

test('password: hashing+verifying completes in reasonable time for interactive login', async () => {
  const start = Date.now();
  const hash = await hashPassword('timing-check-password');
  await verifyPassword('timing-check-password', hash);
  const elapsedMs = Date.now() - start;
  console.log(`    (scrypt hash+verify took ${elapsedMs}ms)`);
  assert.ok(elapsedMs < 3000, `expected under 3s, got ${elapsedMs}ms`);
});

// ---- pairingCode.ts ----
test('pairingCode: generates 6-digit codes with leading zeros preserved', () => {
  for (let i = 0; i < 200; i++) {
    const code = generatePairingCode();
    assert.match(code, /^\d{6}$/);
  }
});

test('pairingCode: generation is not obviously biased (smoke check over many samples)', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) seen.add(generatePairingCode());
  // With 2000 draws from a 1,000,000 space, collisions should be rare;
  // this just guards against a degenerate generator (e.g. always '000000').
  assert.ok(seen.size > 1900, `expected high uniqueness, got ${seen.size}/2000 unique`);
});

test('pairingCode: correct code verifies against its hash; wrong code does not', () => {
  const pepper = 'test-pepper-value';
  const code = '482913';
  const stored = hashPairingCode(code, pepper);
  assert.equal(verifyPairingCode('482913', pepper, stored), true);
  assert.equal(verifyPairingCode('482914', pepper, stored), false);
  assert.equal(verifyPairingCode('482913', 'wrong-pepper', stored), false);
});

test('pairingCode: expiration math', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const expires = computeExpiresAt(15 * 60, now);
  assert.equal(expires?.toISOString(), '2026-01-01T00:15:00.000Z');
  assert.equal(isExpired(expires, new Date('2026-01-01T00:14:59Z')), false);
  assert.equal(isExpired(expires, new Date('2026-01-01T00:15:00Z')), true);
  assert.equal(computeExpiresAt(null, now), null, '"Forever" never computes an expiry');
  assert.equal(isExpired(null, new Date('2099-01-01T00:00:00Z')), false, '"Forever" never expires');
});

test('pairingCode: five failed attempts forces regeneration, not just a timeout', () => {
  let state = { failedAttempts: 0, lockedUntil: null };
  for (let i = 0; i < 4; i++) {
    state = recordFailedAttempt(state);
    assert.equal(state.mustRegenerate, false, `attempt ${i + 1} should not yet force regeneration`);
  }
  state = recordFailedAttempt(state);
  assert.equal(state.mustRegenerate, true);
  assert.equal(isLockedOut(state), true);
});

// ---- tokens.ts ----
test('tokens: access token round-trips and carries the right payload', () => {
  const secret = 'access-token-secret';
  const token = issueAccessToken({ userId: 'user-1', deviceId: 'device-1' }, secret);
  const payload = verifyAccessToken(token, secret);
  assert.equal(payload?.userId, 'user-1');
  assert.equal(payload?.deviceId, 'device-1');
});

test('tokens: access token is rejected with the wrong secret', () => {
  const token = issueAccessToken({ userId: 'user-1', deviceId: 'device-1' }, 'secret-a');
  assert.equal(verifyAccessToken(token, 'secret-b'), null);
});

test('tokens: expired access token is rejected', () => {
  const token = issueAccessToken({ userId: 'user-1', deviceId: 'device-1' }, 'secret', -1);
  assert.equal(verifyAccessToken(token, 'secret'), null);
});

test('tokens: tampered payload is rejected even if JSON-valid', () => {
  const secret = 'secret';
  const token = issueAccessToken({ userId: 'user-1', deviceId: 'device-1' }, secret);
  const [body, sig] = token.split('.');
  const forgedPayload = Buffer.from(JSON.stringify({ userId: 'attacker', deviceId: 'device-1', exp: 9999999999 })).toString('base64url');
  assert.equal(verifyAccessToken(`${forgedPayload}.${sig}`, secret), null);
});

test('tokens: refresh tokens are high-entropy and their hash never reveals the token', () => {
  const t1 = generateRefreshToken();
  const t2 = generateRefreshToken();
  assert.notEqual(t1, t2);
  assert.ok(t1.length >= 40);
  const hash = hashRefreshToken(t1);
  assert.notEqual(hash, t1);
  assert.equal(hashRefreshToken(t1), hash, 'hashing is deterministic so it can be looked up');
});
