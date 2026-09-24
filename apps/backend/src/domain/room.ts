import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  timingSafeEqual,
} from 'node:crypto';

export const MIN_ROOM_NAME_LENGTH = 2;
export const MAX_ROOM_NAME_LENGTH = 50;
export const MIN_ROOM_MEMBERS = 2;
export const MAX_ROOM_MEMBERS = 2000;

export interface RoomNameValidationResult {
  valid: boolean;
  normalized: string;
  error?: string;
}

export function validateRoomName(raw: unknown): RoomNameValidationResult {
  if (typeof raw !== 'string') {
    return { valid: false, normalized: '', error: 'Room name is required' };
  }

  const normalized = raw.trim();
  if (normalized.length < MIN_ROOM_NAME_LENGTH) {
    return {
      valid: false,
      normalized,
      error: `Room name must be at least ${MIN_ROOM_NAME_LENGTH} characters`,
    };
  }

  if (normalized.length > MAX_ROOM_NAME_LENGTH) {
    return {
      valid: false,
      normalized,
      error: `Room name must not exceed ${MAX_ROOM_NAME_LENGTH} characters`,
    };
  }

  // Reject control characters or newlines
  if (/[\u0000-\u001F\u007F]/.test(normalized)) {
    return {
      valid: false,
      normalized,
      error: 'Room name contains invalid characters',
    };
  }

  return { valid: true, normalized };
}

export interface MaxMembersValidationResult {
  valid: boolean;
  value: number;
  error?: string;
}

export function validateMaxMembers(raw: unknown): MaxMembersValidationResult {
  const num = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(num)) {
    return { valid: false, value: 0, error: 'Maximum members must be a whole number' };
  }

  if (num < MIN_ROOM_MEMBERS) {
    return {
      valid: false,
      value: num,
      error: `Maximum members must be at least ${MIN_ROOM_MEMBERS}`,
    };
  }

  if (num > MAX_ROOM_MEMBERS) {
    return {
      valid: false,
      value: num,
      error: `Maximum members cannot exceed ${MAX_ROOM_MEMBERS}`,
    };
  }

  return { valid: true, value: num };
}

const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 32 unambiguous chars (no 0, 1, I, O)

export function generateRoomCode(): string {
  const bytes = randomBytes(9);
  let code = '';
  for (let i = 0; i < 9; i++) {
    code += ROOM_CODE_ALPHABET[bytes[i]! % ROOM_CODE_ALPHABET.length];
  }
  return code;
}

export function normalizeRoomCode(code: string): string {
  return code.trim().toUpperCase();
}

export function hashRoomCode(code: string, pepper: string): string {
  const normalized = normalizeRoomCode(code);
  return createHmac('sha256', pepper).update(normalized).digest('hex');
}

export function verifyRoomCode(code: string, pepper: string, expectedHmac: string): boolean {
  const computed = hashRoomCode(code, pepper);
  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(expectedHmac, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function encryptRoomCode(code: string, pepper: string): string {
  const key = createHash('sha256').update(pepper).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString('base64') + ':' + ciphertext.toString('base64') + ':' + tag.toString('base64');
}

export function decryptRoomCode(encrypted: string, pepper: string): string {
  const parts = encrypted.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted code format');
  const [ivB64, ctB64, tagB64] = parts;
  const key = createHash('sha256').update(pepper).digest();
  const iv = Buffer.from(ivB64!, 'base64');
  const ciphertext = Buffer.from(ctB64!, 'base64');
  const tag = Buffer.from(tagB64!, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8');
}
