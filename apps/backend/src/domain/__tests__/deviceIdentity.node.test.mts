import test from 'node:test';
import assert from 'node:assert/strict';
import { findMatchingDevice } from '../deviceIdentity.ts';
import type { DeviceWithKeys } from '../deviceIdentity.ts';

const deviceA: DeviceWithKeys = { id: 'device-a', identityDhPublic: 'dhA', identitySigningPublic: 'sigA' };
const deviceB: DeviceWithKeys = { id: 'device-b', identityDhPublic: 'dhB', identitySigningPublic: 'sigB' };

test('stable device identity: matches an existing device by both identity keys', () => {
  const match = findMatchingDevice([deviceA, deviceB], { identityDhPublic: 'dhA', identitySigningPublic: 'sigA' });
  assert.equal(match?.id, 'device-a');
});

test('stable device identity: a brand-new key pair matches nothing', () => {
  const match = findMatchingDevice([deviceA, deviceB], { identityDhPublic: 'dh-new', identitySigningPublic: 'sig-new' });
  assert.equal(match, null);
});

test('stable device identity: matching only one of the two keys is not a match', () => {
  // Two independently-generated keys — a coincidental match on one proves
  // nothing about the other, so both must match or it isn't the same device.
  const sameDhDifferentSigning = findMatchingDevice([deviceA], { identityDhPublic: 'dhA', identitySigningPublic: 'sig-different' });
  assert.equal(sameDhDifferentSigning, null);

  const sameSigningDifferentDh = findMatchingDevice([deviceA], { identityDhPublic: 'dh-different', identitySigningPublic: 'sigA' });
  assert.equal(sameSigningDifferentDh, null);
});

test('stable device identity: an empty device list matches nothing (first-ever login)', () => {
  assert.equal(findMatchingDevice([], { identityDhPublic: 'dhA', identitySigningPublic: 'sigA' }), null);
});
