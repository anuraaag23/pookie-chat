import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePassword, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from '../password.ts';

test('Password policy: minimum length is 8', () => {
  assert.equal(MIN_PASSWORD_LENGTH, 8);
  assert.equal(MAX_PASSWORD_LENGTH, 256);
});

test('Password policy: 7-character password is rejected', () => {
  const result = validatePassword('1234567');
  assert.equal(result.valid, false);
  assert.match(result.error ?? '', /at least 8 characters/);
});

test('Password policy: 8-character password is accepted', () => {
  const result = validatePassword('12345678');
  assert.equal(result.valid, true);
  assert.equal(result.error, undefined);
});

test('Password policy: non-string input is rejected', () => {
  assert.equal(validatePassword(null).valid, false);
  assert.equal(validatePassword(12345678).valid, false);
  assert.equal(validatePassword(undefined).valid, false);
});

test('Password policy: 256-character password is accepted', () => {
  assert.equal(validatePassword('a'.repeat(256)).valid, true);
});

test('Password policy: 257-character password is rejected', () => {
  const result = validatePassword('a'.repeat(257));
  assert.equal(result.valid, false);
  assert.match(result.error ?? '', /at most 256 characters/);
});
