import test from 'node:test';
import assert from 'node:assert/strict';
import { signOAuthState, verifyOAuthState } from '../oauthState.ts';

const TEST_SECRET = 'a-test-secret-at-least-20-chars-long';

test('OAuth state: signs state and extracts valid userId', () => {
  const userId = 'user-uuid-12345';
  const state = signOAuthState(userId, TEST_SECRET);

  assert.ok(state.includes('.'));
  const extracted = verifyOAuthState(state, TEST_SECRET);
  assert.equal(extracted, userId);
});

test('OAuth state: rejects tampered signature', () => {
  const state = signOAuthState('user-123', TEST_SECRET);
  const [payload, sig] = state.split('.');
  const tamperedSig = sig.slice(0, -1) + (sig.endsWith('a') ? 'b' : 'a');
  const tampered = `${payload}.${tamperedSig}`;

  assert.throws(() => verifyOAuthState(tampered, TEST_SECRET), /Invalid OAuth state signature/);
});

test('OAuth state: prevents replay (single-use enforcement)', () => {
  const consumedNonces = new Set<string>();
  const state = signOAuthState('user-456', TEST_SECRET);

  const firstUse = verifyOAuthState(state, TEST_SECRET, consumedNonces);
  assert.equal(firstUse, 'user-456');

  // Second use of the same state MUST throw replay error
  assert.throws(() => verifyOAuthState(state, TEST_SECRET, consumedNonces), /OAuth state has already been used/);
});

test('OAuth state: rejects expired state', () => {
  // Sign with negative TTL
  const state = signOAuthState('user-expired', TEST_SECRET, -1000);
  assert.throws(() => verifyOAuthState(state, TEST_SECRET), /OAuth state has expired/);
});

test('OAuth state: rejects invalid format or empty input', () => {
  assert.throws(() => verifyOAuthState('', TEST_SECRET), /Missing or invalid OAuth state parameter/);
  assert.throws(() => verifyOAuthState('not-a-valid-state', TEST_SECRET), /Invalid OAuth state parameter format/);
});
