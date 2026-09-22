import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface OAuthStatePayload {
  userId: string;
  exp: number;
  nonce: string;
}

const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Generates a cryptographically strong, HMAC-SHA256 signed OAuth state parameter
 * bound to the authenticated user ID with a short-lived expiration.
 */
export function signOAuthState(userId: string, secret: string, ttlMs = DEFAULT_STATE_TTL_MS): string {
  const payload: OAuthStatePayload = {
    userId,
    exp: Date.now() + ttlMs,
    nonce: randomBytes(16).toString('hex'),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(payloadB64).digest('base64url');
  return `${payloadB64}.${signature}`;
}

/**
 * Validates HMAC signature, expiration, and optional single-use nonce tracking.
 * Returns the authenticated userId on success, or throws an Error.
 */
export function verifyOAuthState(state: string, secret: string, consumedNonces?: Set<string>): string {
  if (!state || typeof state !== 'string') {
    throw new Error('Missing or invalid OAuth state parameter');
  }
  const parts = state.split('.');
  if (parts.length !== 2) {
    throw new Error('Invalid OAuth state parameter format');
  }

  const [payloadB64, signature] = parts;
  if (!payloadB64 || !signature) {
    throw new Error('Invalid OAuth state parameter format');
  }
  const expectedSig = createHmac('sha256', secret).update(payloadB64).digest('base64url');

  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    throw new Error('Invalid OAuth state signature');
  }

  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Malformed OAuth state payload');
  }

  if (!payload.userId || !payload.exp || !payload.nonce) {
    throw new Error('Incomplete OAuth state payload');
  }

  if (Date.now() > payload.exp) {
    throw new Error('OAuth state has expired. Please try connecting again.');
  }

  if (consumedNonces) {
    if (consumedNonces.has(payload.nonce)) {
      throw new Error('OAuth state has already been used');
    }
    consumedNonces.add(payload.nonce);
    if (consumedNonces.size > 5000) {
      consumedNonces.clear();
    }
  }

  return payload.userId;
}
