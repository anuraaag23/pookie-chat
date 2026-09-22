import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  encryptCredential,
  decryptCredential,
  resolveCredentialKey,
} from '../credentialCipher.ts';

test('credentialCipher: round-trips plaintext tokens correctly', () => {
  const secretKey = randomBytes(32);
  const sampleToken = 'ya29.a0AXooCgu_SomeLongOauthRefreshTokenOrAccessToken-1234567890';

  const encrypted = encryptCredential(sampleToken, secretKey);
  assert.ok(encrypted.includes(':'));
  const parts = encrypted.split(':');
  assert.equal(parts.length, 3); // iv:tag:data
  assert.equal(parts[0].length, 24); // 12 bytes = 24 hex chars
  assert.equal(parts[1].length, 32); // 16 bytes = 32 hex chars

  const decrypted = decryptCredential(encrypted, secretKey);
  assert.equal(decrypted, sampleToken);
});

test('credentialCipher: different encryptions of same plaintext produce different ciphertexts (random IV)', () => {
  const secretKey = randomBytes(32);
  const token = '1//0gRefreshTokenExample';

  const enc1 = encryptCredential(token, secretKey);
  const enc2 = encryptCredential(token, secretKey);

  assert.notEqual(enc1, enc2);
  assert.equal(decryptCredential(enc1, secretKey), token);
  assert.equal(decryptCredential(enc2, secretKey), token);
});

test('credentialCipher: rejects tampered ciphertext or modified auth tag', () => {
  const secretKey = randomBytes(32);
  const token = 'valid-token';
  const encrypted = encryptCredential(token, secretKey);
  const parts = encrypted.split(':');

  // Tamper with data
  const tamperedData = parts[2].slice(0, -2) + (parts[2].endsWith('a') ? 'b' : 'a');
  const tampered = `${parts[0]}:${parts[1]}:${tamperedData}`;

  assert.throws(() => decryptCredential(tampered, secretKey), /Credential decryption failed/);

  // Tamper with auth tag
  const tamperedTag = parts[1].slice(0, -1) + (parts[1].endsWith('0') ? '1' : '0');
  const tamperedWithTag = `${parts[0]}:${tamperedTag}:${parts[2]}`;

  assert.throws(() => decryptCredential(tamperedWithTag, secretKey), /Credential decryption failed/);
});

test('credentialCipher: rejects decryption with wrong key', () => {
  const key1 = randomBytes(32);
  const key2 = randomBytes(32);
  const token = 'secret-refresh-token';

  const encrypted = encryptCredential(token, key1);
  assert.throws(() => decryptCredential(encrypted, key2), /Credential decryption failed/);
});
