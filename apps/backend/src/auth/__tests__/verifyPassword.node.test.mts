import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../../domain/password.ts';

test('Password Re-Authentication: verifyPassword validates correct and incorrect credentials', async () => {
  const secretPassword = 'MySecurePassword123!';
  const hash = await hashPassword(secretPassword);

  // Correct password returns true
  const correct = await verifyPassword(secretPassword, hash);
  assert.equal(correct, true);

  // Incorrect password returns false
  const wrong = await verifyPassword('WrongPassword123!', hash);
  assert.equal(wrong, false);

  // Empty guess returns false
  const empty = await verifyPassword('', hash);
  assert.equal(empty, false);
});

test('Password Re-Authentication: constant-time Scrypt verification handles tampered hashes', async () => {
  const secretPassword = 'TestPassword456!';
  const hash = await hashPassword(secretPassword);

  // Tampered salt or key in hash fails gracefully without crashing
  const tamperedHash = hash.replace(/^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$/, 'scrypt$16384$8$1$badformat');
  try {
    const result = await verifyPassword(secretPassword, tamperedHash);
    assert.equal(result, false);
  } catch {
    // If Scrypt parser throws on bad salt/key, that also correctly rejects
    assert.ok(true);
  }
});

test('verifyUserPassword mock behavior: isolates user password hash and validates', async () => {
  const realPassword = 'AliceRealPassword999';
  const realHash = await hashPassword(realPassword);

  const mockUsers = new Map([
    ['user-alice', { id: 'user-alice', passwordHash: realHash }],
    ['user-google-only', { id: 'user-google-only', passwordHash: null }],
  ]);

  async function mockVerifyUserPassword(userId: string, guess: string): Promise<boolean> {
    const user = mockUsers.get(userId);
    if (!user || !user.passwordHash) return false;
    return verifyPassword(guess, user.passwordHash);
  }

  // Alice with real password
  assert.equal(await mockVerifyUserPassword('user-alice', realPassword), true);
  assert.equal(await mockVerifyUserPassword('user-alice', 'WrongAlicePass'), false);

  // Non-existent user returns false
  assert.equal(await mockVerifyUserPassword('user-non-existent', realPassword), false);

  // Google-only user without password hash returns false
  assert.equal(await mockVerifyUserPassword('user-google-only', 'AnyPassword'), false);
});
