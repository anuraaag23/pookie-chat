/**
 * Session tokens, matching the AuthSession model in
 * docs/02-DATABASE-SCHEMA.md.
 *
 * Two kinds:
 *  - Access tokens: short-lived (15 min default), HMAC-signed and
 *    self-contained, so they verify cryptographically without a database
 *    round-trip. That used to mean they couldn't be revoked before they
 *    expired — AccessTokenGuard now also checks the token's device against
 *    Device.revokedAt on every use (a single indexed lookup), so a revoked
 *    device's access token stops working immediately, not just once it
 *    naturally expires. See docs/05-ROADMAP.md's security-hardening phase
 *    for the distributed-cache version of this check.
 *  - Refresh tokens: opaque random values. Only a hash is ever stored, so
 *    validating one requires a DB read — but that also means they CAN be
 *    revoked instantly (Settings → Sessions → Revoke), which is what
 *    actually implements "log out this device."
 */
import { randomBytes, createHmac, createHash, timingSafeEqual } from 'node:crypto';

export interface AccessTokenPayload {
  userId: string;
  deviceId: string;
  exp: number; // unix seconds
}

function b64url(input: Buffer): string {
  return input.toString('base64url');
}

export function issueAccessToken(
  payload: Omit<AccessTokenPayload, 'exp'>,
  secret: string,
  ttlSeconds = 15 * 60,
): string {
  const full: AccessTokenPayload = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const body = b64url(Buffer.from(JSON.stringify(full)));
  const signature = b64url(createHmac('sha256', secret).update(body).digest());
  return `${body}.${signature}`;
}

/** Returns the payload if the token is validly signed and unexpired, otherwise null. Never throws — malformed input just fails verification. */
export function verifyAccessToken(token: string, secret: string): AccessTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  // Runtime-safe: the length check above guarantees exactly 2 elements.
  const [body, signature] = parts as [string, string];

  let sigBuf: Buffer;
  let expectedBuf: Buffer;
  try {
    sigBuf = Buffer.from(signature, 'base64url');
    expectedBuf = createHmac('sha256', secret).update(body).digest();
  } catch {
    return null;
  }
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as AccessTokenPayload;
    if (typeof payload.exp !== 'number' || Date.now() / 1000 >= payload.exp) return null;
    if (typeof payload.userId !== 'string' || typeof payload.deviceId !== 'string') return null;
    return payload;
  } catch {
    return null;
  }
}

/** 256 bits of CSPRNG entropy — unguessable, so the stored hash needs no secret pepper the way the (low-entropy) pairing code does. */
export function generateRefreshToken(): string {
  return b64url(randomBytes(32));
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('base64');
}

/** The raw IP is never stored (see AuthSession.ipHash) — only enough to notice "this session's IP changed" without keeping an identifying value around. */
export function hashIp(ip: string): string {
  return createHash('sha256').update(ip).digest('base64');
}
