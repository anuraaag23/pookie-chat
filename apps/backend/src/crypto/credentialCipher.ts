import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12; // 96 bits recommended for AES-GCM
const AUTH_TAG_LENGTH_BYTES = 16; // 128 bits authentication tag

/**
 * Resolves or derives a 32-byte encryption key for AES-256-GCM.
 * If provided a key Buffer, checks length (must be 32 bytes).
 * If provided a string, hashes via SHA-256 to ensure exact 32 bytes.
 * If no key provided, reads GOOGLE_DRIVE_CREDENTIAL_KEY or falls back to JWT_ACCESS_SECRET in dev.
 */
export function resolveCredentialKey(customKey?: string | Buffer): Buffer {
  if (customKey) {
    if (Buffer.isBuffer(customKey)) {
      if (customKey.length !== 32) {
        throw new Error(`Credential encryption key buffer must be exactly 32 bytes, got ${customKey.length}`);
      }
      return customKey;
    }
    return createHash('sha256').update(customKey).digest();
  }

  const envKey = process.env.GOOGLE_DRIVE_CREDENTIAL_KEY || process.env.JWT_ACCESS_SECRET;
  if (!envKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('GOOGLE_DRIVE_CREDENTIAL_KEY environment variable is required in production');
    }
    // Dev fallback key derived from fixed dev seed
    return createHash('sha256').update('dev-credential-cipher-fallback-key').digest();
  }
  return createHash('sha256').update(envKey).digest();
}

/**
 * Encrypts sensitive OAuth tokens at rest using AES-256-GCM.
 * Output format: <hex_iv>:<hex_auth_tag>:<hex_ciphertext>
 */
export function encryptCredential(plaintext: string, keyBuffer?: Buffer): string {
  if (!plaintext) return '';
  const key = resolveCredentialKey(keyBuffer);
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH_BYTES });

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts sensitive OAuth tokens from AES-256-GCM ciphertext.
 * Validates integrity via GCM authentication tag.
 */
export function decryptCredential(formattedCiphertext: string, keyBuffer?: Buffer): string {
  if (!formattedCiphertext) return '';
  const parts = formattedCiphertext.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid credential ciphertext format');
  }

  const [ivHex, tagHex, dataHex] = parts;
  if (!ivHex || !tagHex || !dataHex) {
    throw new Error('Invalid credential ciphertext format');
  }
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const encrypted = Buffer.from(dataHex, 'hex');

  if (iv.length !== IV_LENGTH_BYTES || tag.length !== AUTH_TAG_LENGTH_BYTES) {
    throw new Error('Invalid IV or auth tag length in credential ciphertext');
  }

  const key = resolveCredentialKey(keyBuffer);
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH_BYTES });
  decipher.setAuthTag(tag);

  try {
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (err) {
    throw new Error('Credential decryption failed: invalid authentication tag or corrupted data');
  }
}
