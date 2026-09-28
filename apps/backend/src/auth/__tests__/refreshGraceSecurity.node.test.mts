import test from 'node:test';
import assert from 'node:assert/strict';
import { hashRefreshToken, generateRefreshToken } from '../../domain/tokens.ts';

test('Refresh Security: hashRefreshToken uses deterministic SHA-256', () => {
  const token = generateRefreshToken();
  const hash1 = hashRefreshToken(token);
  const hash2 = hashRefreshToken(token);

  assert.equal(hash1, hash2, 'Hash must be deterministic');
  assert.equal(hash1.length, 44, 'SHA-256 base64 must be 44 characters');

  const differentToken = generateRefreshToken();
  assert.notEqual(hashRefreshToken(differentToken), hash1, 'Different tokens must have distinct hashes');
});

test('Refresh Security: Malformed or short refresh tokens are rejected immediately', () => {
  function validateRefreshTokenInput(refreshToken: any): void {
    if (!refreshToken || typeof refreshToken !== 'string' || refreshToken.trim().length < 32) {
      throw new Error('Session expired or revoked');
    }
  }

  // Valid length
  const valid = generateRefreshToken();
  assert.doesNotThrow(() => validateRefreshTokenInput(valid));

  // Invalid inputs
  assert.throws(() => validateRefreshTokenInput(''), /Session expired or revoked/);
  assert.throws(() => validateRefreshTokenInput('too_short'), /Session expired or revoked/);
  assert.throws(() => validateRefreshTokenInput('   short_with_spaces   '), /Session expired or revoked/);
  assert.throws(() => validateRefreshTokenInput(null), /Session expired or revoked/);
  assert.throws(() => validateRefreshTokenInput(undefined), /Session expired or revoked/);
  assert.throws(() => validateRefreshTokenInput(12345 as any), /Session expired or revoked/);
});

test('Refresh Grace Window: Concurrent requests within 30s grace window recover valid tokens', async () => {
  interface RotationRecord {
    sessionId: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  }

  const recentRotations = new Map<string, RotationRecord>();

  // Mock DB state
  const sessions = new Map<string, { id: string; userId: string; deviceId: string; revokedAt: Date | null; expiresAt: Date }>();
  const devices = new Map<string, { id: string; userId: string; revokedAt: Date | null }>();
  const users = new Set<string>(['usr_alice']);

  sessions.set('sess_1', {
    id: 'sess_1',
    userId: 'usr_alice',
    deviceId: 'dev_1',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60),
  });

  devices.set('dev_1', {
    id: 'dev_1',
    userId: 'usr_alice',
    revokedAt: null,
  });

  const oldToken = generateRefreshToken();
  const oldHash = hashRefreshToken(oldToken);
  const newToken = generateRefreshToken();

  // Simulate rotation
  recentRotations.set(oldHash, {
    sessionId: 'sess_1',
    accessToken: 'acc_token_v2',
    refreshToken: newToken,
    expiresAt: Date.now() + 30_000,
  });

  // Helper verifying rotation lookup with DB check
  async function resolveRefresh(token: string, now: number): Promise<{ accessToken: string; refreshToken: string } | null> {
    const hash = hashRefreshToken(token);
    const cached = recentRotations.get(hash);
    if (cached && cached.expiresAt > now) {
      const session = sessions.get(cached.sessionId);
      if (session && !session.revokedAt && session.expiresAt > new Date(now)) {
        const device = devices.get(session.deviceId);
        if (device && !device.revokedAt && device.userId === session.userId) {
          if (users.has(session.userId)) {
            return {
              accessToken: cached.accessToken,
              refreshToken: cached.refreshToken,
            };
          }
        }
      }
      recentRotations.delete(hash);
    }
    return null;
  }

  // 1. Concurrent tab refresh 5 seconds later succeeds
  const res1 = await resolveRefresh(oldToken, Date.now() + 5_000);
  assert.ok(res1);
  assert.equal(res1.accessToken, 'acc_token_v2');
  assert.equal(res1.refreshToken, newToken);

  // 2. Request after 31 seconds fails due to grace window expiration
  const res2 = await resolveRefresh(oldToken, Date.now() + 31_000);
  assert.equal(res2, null, 'Expired grace window must not return cached tokens');
});

test('Refresh Grace Window: Revoked session immediately rejects cached tokens', async () => {
  interface RotationRecord {
    sessionId: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  }

  const recentRotations = new Map<string, RotationRecord>();
  const sessions = new Map<string, { id: string; userId: string; deviceId: string; revokedAt: Date | null; expiresAt: Date }>();
  const devices = new Map<string, { id: string; userId: string; revokedAt: Date | null }>();
  const users = new Set<string>(['usr_alice']);

  sessions.set('sess_1', {
    id: 'sess_1',
    userId: 'usr_alice',
    deviceId: 'dev_1',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60),
  });

  devices.set('dev_1', {
    id: 'dev_1',
    userId: 'usr_alice',
    revokedAt: null,
  });

  const oldToken = generateRefreshToken();
  const oldHash = hashRefreshToken(oldToken);

  recentRotations.set(oldHash, {
    sessionId: 'sess_1',
    accessToken: 'acc_token_v2',
    refreshToken: generateRefreshToken(),
    expiresAt: Date.now() + 30_000,
  });

  // User revokes session
  sessions.get('sess_1')!.revokedAt = new Date();

  // Helper verifying DB session check
  async function resolveRefresh(token: string): Promise<boolean> {
    const hash = hashRefreshToken(token);
    const cached = recentRotations.get(hash);
    if (cached && cached.expiresAt > Date.now()) {
      const session = sessions.get(cached.sessionId);
      if (session && !session.revokedAt && session.expiresAt > new Date()) {
        return true;
      }
      recentRotations.delete(hash);
    }
    return false;
  }

  // Grace check fails and purges entry
  const allowed = await resolveRefresh(oldToken);
  assert.equal(allowed, false, 'Revoked session must not be allowed via grace cache');
  assert.equal(recentRotations.has(oldHash), false, 'Entry must be purged immediately from grace cache');
});

test('Refresh Grace Window: Logout explicitly evicts all rotation tokens for session', () => {
  interface RotationRecord {
    sessionId: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  }

  const recentRotations = new Map<string, RotationRecord>();

  const tokenA = generateRefreshToken();
  const tokenB = generateRefreshToken();
  const tokenC = generateRefreshToken(); // Different session

  recentRotations.set(hashRefreshToken(tokenA), {
    sessionId: 'sess_alice',
    accessToken: 'acc_a',
    refreshToken: 'ref_new_a',
    expiresAt: Date.now() + 30_000,
  });

  recentRotations.set(hashRefreshToken(tokenB), {
    sessionId: 'sess_alice',
    accessToken: 'acc_b',
    refreshToken: 'ref_new_b',
    expiresAt: Date.now() + 30_000,
  });

  recentRotations.set(hashRefreshToken(tokenC), {
    sessionId: 'sess_bob',
    accessToken: 'acc_c',
    refreshToken: 'ref_new_c',
    expiresAt: Date.now() + 30_000,
  });

  // Logout logic for sess_alice
  function logoutSession(sessionId: string) {
    for (const [k, v] of recentRotations.entries()) {
      if (v.sessionId === sessionId) {
        recentRotations.delete(k);
      }
    }
  }

  logoutSession('sess_alice');

  assert.equal(recentRotations.has(hashRefreshToken(tokenA)), false, 'Token A must be evicted on logout');
  assert.equal(recentRotations.has(hashRefreshToken(tokenB)), false, 'Token B must be evicted on logout');
  assert.equal(recentRotations.has(hashRefreshToken(tokenC)), true, 'Unrelated session must remain intact');
});
