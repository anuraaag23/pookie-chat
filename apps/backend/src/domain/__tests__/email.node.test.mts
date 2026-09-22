import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeEmail,
  validateEmail,
  generateVerificationCode,
  hashVerificationCode,
  verifyVerificationCode,
} from '../email.ts';

test('normalizeEmail: trims whitespace and lowercases only', () => {
  assert.equal(normalizeEmail(' User@Example.COM '), 'user@example.com');
  assert.equal(normalizeEmail('\tAlice.Smith@Domain.ORG\n'), 'alice.smith@domain.org');
});

test('normalizeEmail: preserves dots and plus tags without provider-specific stripping', () => {
  const emailWithDots = 'john.doe.personal@gmail.com';
  assert.equal(normalizeEmail(emailWithDots), 'john.doe.personal@gmail.com');

  const emailWithPlus = 'user+newsletter@protonmail.com';
  assert.equal(normalizeEmail(emailWithPlus), 'user+newsletter@protonmail.com');

  // Case-insensitivity check while preserving plus
  assert.equal(normalizeEmail(' User+TAG@Outlook.com '), 'user+tag@outlook.com');
});

test('validateEmail: accepts valid emails', () => {
  assert.equal(validateEmail('alice@example.com').valid, true);
  assert.equal(validateEmail('user.name+tag@sub.domain.co.uk').valid, true);
  assert.equal(validateEmail('test_123-abc@domain.io').valid, true);
});

test('validateEmail: rejects invalid formats', () => {
  assert.equal(validateEmail('').valid, false);
  assert.equal(validateEmail('not-an-email').valid, false);
  assert.equal(validateEmail('missing@domain').valid, false);
  assert.equal(validateEmail('double@@domain.com').valid, false);
  assert.equal(validateEmail('has space@domain.com').valid, false);
  assert.equal(validateEmail('user@.com').valid, false);
  assert.equal(validateEmail('.leadingdot@domain.com').valid, false);
  assert.equal(validateEmail('trailingdot.@domain.com').valid, false);
  assert.equal(validateEmail('double..dots@domain.com').valid, false);
});

test('validateEmail: rejects excessive length (> 254 characters)', () => {
  const longLocal = 'a'.repeat(245);
  const tooLong = `${longLocal}@example.com`;
  assert.ok(tooLong.length > 254);
  const result = validateEmail(tooLong);
  assert.equal(result.valid, false);
  assert.match(result.error ?? '', /between 5 and 254 characters/);
});

test('generateVerificationCode: generates 6-digit numeric string', () => {
  for (let i = 0; i < 20; i++) {
    const code = generateVerificationCode();
    assert.match(code, /^\d{6}$/);
    const num = Number(code);
    assert.ok(num >= 100000 && num <= 999999);
  }
});

test('hashVerificationCode and verifyVerificationCode: hashes and validates correctly', () => {
  const code = '742918';
  const hash = hashVerificationCode(code);
  assert.equal(hash.length, 64); // SHA-256 hex string

  assert.equal(verifyVerificationCode(code, hash), true);
  assert.equal(verifyVerificationCode(' 742918 ', hash), true); // handles trimmed match
  assert.equal(verifyVerificationCode('742919', hash), false);
  assert.equal(verifyVerificationCode('000000', hash), false);
});
