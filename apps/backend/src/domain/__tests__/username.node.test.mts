import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsername, validateUsername, nextUsernameChangeAllowedAt, isUsernameChangeCoolingDown, USERNAME_CHANGE_COOLDOWN_DAYS } from '../username.ts';

test('username: valid examples are accepted', () => {
  for (const u of ['anuraaag12', 'anurag_23', 'pookiechat', 'user123', 'abc', 'a12345678901234567890123456789']) {
    assert.equal(validateUsername(u).valid, true, `expected "${u}" to be valid`);
  }
});

test('username: too short is rejected', () => {
  assert.equal(validateUsername('an').valid, false);
});

test('username: too long is rejected', () => {
  assert.equal(validateUsername('a'.repeat(31)).valid, false);
});

test('username: uppercase/space input is rejected before normalization', () => {
  // validateUsername checks the value as given — callers normalize first.
  assert.equal(validateUsername('Anurag 12').valid, false);
});

test('username: leading "@" is rejected, not stripped', () => {
  assert.equal(validateUsername('@anuraaag12').valid, false);
});

test('username: leading underscore is rejected', () => {
  assert.equal(validateUsername('_anurag').valid, false);
});

test('username: trailing underscore is rejected', () => {
  assert.equal(validateUsername('anurag_').valid, false);
});

test('username: consecutive underscores are rejected', () => {
  assert.equal(validateUsername('anurag__12').valid, false);
});

test('username: hyphen is rejected (underscore only, no hyphen)', () => {
  assert.equal(validateUsername('anurag-12').valid, false);
});

test('username: starting with a digit is rejected', () => {
  assert.equal(validateUsername('1anurag').valid, false);
});

test('username: normalizeUsername trims and lowercases only', () => {
  assert.equal(normalizeUsername('  AnuraaaG12  '), 'anuraaag12');
  // Normalization never removes characters — an embedded space or "@"
  // survives normalization and must fail validateUsername afterward,
  // rather than being silently stripped into something different from
  // what was typed.
  assert.equal(normalizeUsername('Anu Rag'), 'anu rag');
  assert.equal(validateUsername(normalizeUsername('Anu Rag')).valid, false);
  assert.equal(normalizeUsername('@Anurag'), '@anurag');
  assert.equal(validateUsername(normalizeUsername('@Anurag')).valid, false);
});

test('username: case-insensitive duplicates normalize to the same stored value', () => {
  assert.equal(normalizeUsername('AnuraaaG12'), normalizeUsername('anuraaag12'));
});

test('username change cooldown: never changed (null) means no cooldown', () => {
  assert.equal(nextUsernameChangeAllowedAt(null), null);
  assert.equal(isUsernameChangeCoolingDown(null), false);
});

test('username change cooldown: a change today blocks another change for the full window', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const changedAt = new Date('2026-01-01T00:00:00.000Z');
  assert.equal(isUsernameChangeCoolingDown(changedAt, now), true);
  const nextAllowed = nextUsernameChangeAllowedAt(changedAt)!;
  assert.equal(nextAllowed.toISOString(), '2026-04-01T00:00:00.000Z');
});

test(`username change cooldown: exactly ${USERNAME_CHANGE_COOLDOWN_DAYS} days later is allowed again`, () => {
  const changedAt = new Date('2026-01-01T00:00:00.000Z');
  const oneDayShort = new Date(changedAt.getTime() + (USERNAME_CHANGE_COOLDOWN_DAYS - 1) * 86400000);
  const exactlyDue = new Date(changedAt.getTime() + USERNAME_CHANGE_COOLDOWN_DAYS * 86400000);
  assert.equal(isUsernameChangeCoolingDown(changedAt, oneDayShort), true);
  assert.equal(isUsernameChangeCoolingDown(changedAt, exactlyDue), false);
});
