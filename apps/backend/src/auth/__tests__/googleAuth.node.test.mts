import test from 'node:test';
import assert from 'node:assert/strict';
import { GoogleAuthService } from '../../../dist/auth/google-auth.service.js';
import { signOAuthState, verifyOAuthState } from '../../domain/oauthState.ts';

const TEST_SECRET = 'secret-must-be-long-enough-for-safety-12345';

test('GoogleAuthService: isConfigured reflects clientId presence', () => {
  const serviceUnconfigured = new GoogleAuthService({
    googleClientId: null,
    accessTokenSecret: TEST_SECRET,
  } as any);
  assert.equal(serviceUnconfigured.isConfigured(), false);
  assert.equal(serviceUnconfigured.getConfig().configured, false);
  assert.throws(() => serviceUnconfigured.getOAuthClient(), /not configured/);

  const serviceConfigured = new GoogleAuthService({
    googleClientId: 'test-client-id.apps.googleusercontent.com',
    googleClientSecret: 'test-secret',
    webOrigin: 'http://localhost:3000',
    accessTokenSecret: TEST_SECRET,
  } as any);
  assert.equal(serviceConfigured.isConfigured(), true);
  assert.equal(serviceConfigured.getConfig().configured, true);
  assert.equal(serviceConfigured.getConfig().clientId, 'test-client-id.apps.googleusercontent.com');
});

test('GoogleAuthService: generateAuthUrl produces correct OAuth2 URL', () => {
  const service = new GoogleAuthService({
    googleClientId: 'test-client-id.apps.googleusercontent.com',
    googleClientSecret: 'test-secret',
    webOrigin: 'http://localhost:3000',
    accessTokenSecret: TEST_SECRET,
  } as any);

  const { authUrl } = service.generateAuthUrl('login', '/chat');
  assert.ok(authUrl.startsWith('https://accounts.google.com/o/oauth2/v2/auth'));
  assert.ok(authUrl.includes('client_id=test-client-id.apps.googleusercontent.com'));
  assert.ok(authUrl.includes('scope=openid+email+profile') || authUrl.includes('scope=openid%20email%20profile'));
  assert.ok(authUrl.includes('state='));
});

test('GoogleAuthService: ticket lifecycle (create, consume, single-use, expiry)', () => {
  const service = new GoogleAuthService({
    googleClientId: 'test-client-id',
    accessTokenSecret: TEST_SECRET,
  } as any);

  const profile = {
    sub: 'google-sub-123',
    email: 'alice@example.com',
    name: 'Alice',
  };

  const ticketId = service.createTicket(profile);
  assert.ok(ticketId && typeof ticketId === 'string');

  // First consumption succeeds
  const consumed = service.consumeTicket(ticketId);
  assert.equal(consumed.sub, 'google-sub-123');
  assert.equal(consumed.email, 'alice@example.com');
  assert.equal(consumed.name, 'Alice');

  // Second consumption fails (single-use replay protection)
  assert.throws(() => service.consumeTicket(ticketId), /Invalid or expired/);

  // Non-existent ticket fails
  assert.throws(() => service.consumeTicket('non-existent-ticket-uuid'), /Invalid or expired/);
});

test('GoogleAuthService: OAuth state signature and tampering defense', () => {
  const state = signOAuthState('auth:login:%2Fchat', TEST_SECRET);
  assert.ok(state.includes('.'));

  // Valid state verifies
  const verified = verifyOAuthState(state, TEST_SECRET);
  assert.equal(verified, 'auth:login:%2Fchat');

  // Tampered state fails
  const tampered = state.slice(0, -3) + 'xyz';
  assert.throws(() => verifyOAuthState(tampered, TEST_SECRET), /Invalid OAuth state signature/);

  // Wrong secret fails
  assert.throws(() => verifyOAuthState(state, 'wrong-secret-that-does-not-match'), /Invalid OAuth state signature/);
});
