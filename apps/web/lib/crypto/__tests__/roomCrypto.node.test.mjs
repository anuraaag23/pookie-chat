import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateRoomKey,
  encryptRoomKeyForRecipient,
  decryptRoomKeyFromSender,
  encryptRoomMessage,
  decryptRoomMessage,
  bytesToBase64,
  base64ToBytes,
} from '../roomCrypto.ts';

test('roomCrypto: generateRoomKey produces 32 random bytes', () => {
  const k1 = generateRoomKey();
  const k2 = generateRoomKey();
  assert.equal(k1.length, 32);
  assert.equal(k2.length, 32);
  assert.notDeepEqual(k1, k2);
});

test('roomCrypto: pairwise room key wrapping via X25519-HKDF-AES-GCM', async () => {
  // Device A
  const keyPairA = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  const pubRawA = await crypto.subtle.exportKey('raw', keyPairA.publicKey);
  const pubB64A = bytesToBase64(new Uint8Array(pubRawA));

  // Device B
  const keyPairB = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  const pubRawB = await crypto.subtle.exportKey('raw', keyPairB.publicKey);
  const pubB64B = bytesToBase64(new Uint8Array(pubRawB));

  const roomKey = generateRoomKey();

  // A encrypts room key for B
  const { encryptedKey, nonce } = await encryptRoomKeyForRecipient(
    roomKey,
    pubB64B,
    keyPairA.privateKey,
  );

  // B decrypts room key from A
  const recoveredKey = await decryptRoomKeyFromSender(
    encryptedKey,
    nonce,
    pubB64A,
    keyPairB.privateKey,
  );

  assert.deepEqual(recoveredKey, roomKey);
});

test('roomCrypto: group message encryption and decryption with AAD', async () => {
  const roomKey = generateRoomKey();
  const messageText = 'Hello Pookie Chat room members!';
  const aad = new TextEncoder().encode('room-123:seq-1');

  const { ciphertext, iv } = await encryptRoomMessage(roomKey, messageText, aad);
  assert.notEqual(ciphertext, messageText);

  // Decrypt with correct AAD
  const decrypted = await decryptRoomMessage(roomKey, ciphertext, iv, aad);
  assert.equal(decrypted, messageText);

  // Decrypt with tampered AAD fails
  const badAad = new TextEncoder().encode('room-999:seq-1');
  await assert.rejects(() => decryptRoomMessage(roomKey, ciphertext, iv, badAad));

  // Decrypt with wrong key fails
  const wrongKey = generateRoomKey();
  await assert.rejects(() => decryptRoomMessage(wrongKey, ciphertext, iv, aad));
});

test('roomCrypto: open room key encryption and decryption via code-derived key', async () => {
  const roomKey = generateRoomKey();
  const roomCode = 'ROOM-789X';

  const { openKeyCiphertext, openKeyNonce } = await (await import('../roomCrypto.ts')).encryptOpenRoomKey(roomKey, roomCode);
  const recoveredKey = await (await import('../roomCrypto.ts')).decryptOpenRoomKey(openKeyCiphertext, openKeyNonce, roomCode);

  assert.deepEqual(recoveredKey, roomKey);

  // Wrong code fails decryption
  await assert.rejects(() =>
    (async () => {
      const { decryptOpenRoomKey } = await import('../roomCrypto.ts');
      await decryptOpenRoomKey(openKeyCiphertext, openKeyNonce, 'WRONG-CODE');
    })(),
  );
});
