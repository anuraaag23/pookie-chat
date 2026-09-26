/**
 * Pookie Chat — Client-Side Group Room Crypto Engine
 *
 * Implements zero-knowledge multi-party end-to-end encryption for chat rooms.
 * - Server never stores or sees plaintext messages or room keys.
 * - Room keys are generated client-side by the creator / members.
 * - Keys are distributed pairwise via X25519 ECDH + HKDF key wrapping.
 * - Messages are encrypted with AES-256-GCM authenticated encryption with AAD.
 */

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bs(u: Uint8Array): BufferSource {
  return u as unknown as BufferSource;
}

export function generateRoomKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: string,
  lengthBytes: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', bs(ikm), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: bs(salt),
      info: bs(new TextEncoder().encode(info)),
    },
    key,
    lengthBytes * 8,
  );
  return new Uint8Array(bits);
}

async function dh(privateKey: CryptoKey, peerPublicKeyB64: string): Promise<Uint8Array> {
  const peerKey = await crypto.subtle.importKey(
    'raw',
    bs(base64ToBytes(peerPublicKeyB64)),
    { name: 'X25519' },
    false,
    [],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'X25519', public: peerKey },
    privateKey,
    256,
  );
  return new Uint8Array(bits);
}

export async function encryptRoomKeyForRecipient(
  roomKey: Uint8Array,
  recipientIdentityDhPublic: string,
  myIdentityDhPrivateKey: CryptoKey,
): Promise<{ encryptedKey: string; nonce: string }> {
  const sharedSecret = await dh(myIdentityDhPrivateKey, recipientIdentityDhPublic);
  const wrapKeyBytes = await hkdf(
    sharedSecret,
    new Uint8Array(32),
    'pookie-chat-room-key-wrap',
    32,
  );
  const wrapKey = await crypto.subtle.importKey('raw', bs(wrapKeyBytes), 'AES-GCM', false, [
    'encrypt',
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: bs(iv) },
    wrapKey,
    bs(roomKey),
  );
  return {
    encryptedKey: bytesToBase64(new Uint8Array(ciphertext)),
    nonce: bytesToBase64(iv),
  };
}

export async function decryptRoomKeyFromSender(
  encryptedKeyB64: string,
  nonceB64: string,
  senderIdentityDhPublic: string,
  myIdentityDhPrivateKey: CryptoKey,
): Promise<Uint8Array> {
  const sharedSecret = await dh(myIdentityDhPrivateKey, senderIdentityDhPublic);
  const wrapKeyBytes = await hkdf(
    sharedSecret,
    new Uint8Array(32),
    'pookie-chat-room-key-wrap',
    32,
  );
  const wrapKey = await crypto.subtle.importKey('raw', bs(wrapKeyBytes), 'AES-GCM', false, [
    'decrypt',
  ]);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bs(base64ToBytes(nonceB64)) },
    wrapKey,
    bs(base64ToBytes(encryptedKeyB64)),
  );
  return new Uint8Array(decrypted);
}

export async function encryptRoomMessage(
  roomKey: Uint8Array,
  plaintext: string,
  aad: Uint8Array,
): Promise<{ ciphertext: string; iv: string }> {
  const key = await crypto.subtle.importKey('raw', bs(roomKey), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: bs(iv), additionalData: bs(aad) },
    key,
    bs(encoded),
  );
  return {
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    iv: bytesToBase64(iv),
  };
}

export async function decryptRoomMessage(
  roomKey: Uint8Array,
  ciphertextB64: string,
  ivB64: string,
  aad: Uint8Array,
): Promise<string> {
  const key = await crypto.subtle.importKey('raw', bs(roomKey), 'AES-GCM', false, ['decrypt']);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bs(base64ToBytes(ivB64)), additionalData: bs(aad) },
    key,
    bs(base64ToBytes(ciphertextB64)),
  );
  return new TextDecoder().decode(decrypted);
}

export async function deriveOpenRoomCodeKey(code: string): Promise<CryptoKey> {
  const codeBytes = new TextEncoder().encode(code.trim().toUpperCase());
  const hash = await crypto.subtle.digest('SHA-256', bs(codeBytes));
  return await crypto.subtle.importKey('raw', bs(new Uint8Array(hash)), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptOpenRoomKey(
  roomKey: Uint8Array,
  code: string,
): Promise<{ openKeyCiphertext: string; openKeyNonce: string }> {
  const key = await deriveOpenRoomCodeKey(code);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: bs(iv) },
    key,
    bs(roomKey),
  );
  return {
    openKeyCiphertext: bytesToBase64(new Uint8Array(ciphertext)),
    openKeyNonce: bytesToBase64(iv),
  };
}

export async function decryptOpenRoomKey(
  ciphertextB64: string,
  nonceB64: string,
  code: string,
): Promise<Uint8Array> {
  const key = await deriveOpenRoomCodeKey(code);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bs(base64ToBytes(nonceB64)) },
    key,
    bs(base64ToBytes(ciphertextB64)),
  );
  return new Uint8Array(decrypted);
}
