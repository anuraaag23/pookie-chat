import test from 'node:test';
import assert from 'node:assert/strict';
import { nextEpoch, isStaleEpoch, isUsableForHandshake } from '../sessionEpoch.ts';

test('epoch: advances by exactly one', () => {
  assert.equal(nextEpoch(1), 2);
  assert.equal(nextEpoch(2), 3);
  assert.equal(nextEpoch(41), 42);
});

test('epoch: a claim matching the current epoch is not stale', () => {
  assert.equal(isStaleEpoch(3, 3), false);
});

test('epoch: a claim behind the current epoch is stale (the burn+re-pair case)', () => {
  // e.g. a device cached epoch 1 (its session from the original
  // pairing); the conversation has since been burned and re-paired,
  // advancing the authoritative epoch to 2.
  assert.equal(isStaleEpoch(1, 2), true);
});

test('epoch: a claim ahead of the current epoch is still flagged, not just "behind"', () => {
  // Should never happen in practice (epoch only moves forward, and a
  // client can't learn of an epoch before the server issues it), but
  // the check is a strict inequality, not "greater than" — any mismatch
  // in either direction is untrusted.
  assert.equal(isStaleEpoch(5, 2), true);
});

test('epoch: an absent claim is stale — sessionEpoch is mandatory in V1', () => {
  assert.equal(isStaleEpoch(undefined, 1), true);
  assert.equal(isStaleEpoch(undefined, 99), true);
});

test('epoch: zero is a legitimate epoch value to compare, not treated like "absent"', () => {
  // Guards against a `!claimedEpoch` style check, which would wrongly
  // treat epoch 0 as "no claim provided" if epochs ever started at 0
  // instead of 1 — they don't (schema default is 1), but the function
  // itself should not assume that by accident.
  assert.equal(isStaleEpoch(0, 1), true);
  assert.equal(isStaleEpoch(0, 0), false);
});

test('handshake usability: only ACTIVE conversations can accept new handshake material', () => {
  assert.equal(isUsableForHandshake('ACTIVE'), true);
  assert.equal(isUsableForHandshake('DELETED'), false);
  assert.equal(isUsableForHandshake('BLOCKED_BY_A'), false);
  assert.equal(isUsableForHandshake('BLOCKED_BY_B'), false);
});
