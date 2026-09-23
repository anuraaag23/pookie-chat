import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateRoomName,
  validateMaxMembers,
  generateRoomCode,
  normalizeRoomCode,
  encryptRoomCode,
  decryptRoomCode,
  hashRoomCode,
  verifyRoomCode,
  MIN_ROOM_NAME_LENGTH,
  MAX_ROOM_NAME_LENGTH,
  MIN_ROOM_MEMBERS,
  MAX_ROOM_MEMBERS,
} from '../room.ts';

test('validateRoomName: valid names are accepted and trimmed', () => {
  const r1 = validateRoomName('  Cool Group  ');
  assert.equal(r1.valid, true);
  assert.equal(r1.normalized, 'Cool Group');

  const minName = 'A'.repeat(MIN_ROOM_NAME_LENGTH);
  assert.equal(validateRoomName(minName).valid, true);

  const maxName = 'A'.repeat(MAX_ROOM_NAME_LENGTH);
  assert.equal(validateRoomName(maxName).valid, true);
});

test('validateRoomName: invalid names are rejected', () => {
  assert.equal(validateRoomName(null).valid, false);
  assert.equal(validateRoomName('').valid, false);
  assert.equal(validateRoomName('   ').valid, false);
  assert.equal(validateRoomName('A').valid, false); // < 2 chars
  assert.equal(validateRoomName('A'.repeat(MAX_ROOM_NAME_LENGTH + 1)).valid, false); // > 50 chars
  assert.equal(validateRoomName('Bad\x00Name').valid, false);
});

test('validateMaxMembers: boundary and type checks', () => {
  assert.equal(validateMaxMembers(2).valid, true);
  assert.equal(validateMaxMembers(10).valid, true);
  assert.equal(validateMaxMembers(100).valid, true);
  assert.equal(validateMaxMembers('10').valid, true);

  assert.equal(validateMaxMembers(1).valid, false);
  assert.equal(validateMaxMembers(0).valid, false);
  assert.equal(validateMaxMembers(-5).valid, false);
  assert.equal(validateMaxMembers(101).valid, false);
  assert.equal(validateMaxMembers(3.14).valid, false);
  assert.equal(validateMaxMembers('invalid').valid, false);
});

test('Room Code: 9-character generation and cryptographic AES-256-GCM round-trip', () => {
  const code = generateRoomCode();
  assert.equal(code.length, 9);
  assert.match(code, /^[2-9A-Z]{9}$/);

  const normalized = normalizeRoomCode('  ' + code.toLowerCase() + '  ');
  assert.equal(normalized, code);

  const pepper = 'test-pepper-sufficiently-long-for-hmac-32-bytes!';
  const encrypted = encryptRoomCode(code, pepper);
  assert.notEqual(encrypted, code);
  assert.equal(decryptRoomCode(encrypted, pepper), code);

  const hmac = hashRoomCode(code, pepper);
  assert.equal(verifyRoomCode(code, pepper, hmac), true);
  assert.equal(verifyRoomCode(code.toLowerCase(), pepper, hmac), true);
  assert.equal(verifyRoomCode('WRONGCODE', pepper, hmac), false);
});
