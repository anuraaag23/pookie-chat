/**
 * Client-Side Token Validation Utilities
 *
 * Inspects access tokens to ensure sessions are genuine and unexpired.
 * Prevents treating stale IndexedDB records or expired access tokens as authenticated.
 */

export interface TokenPayload {
  userId: string;
  deviceId: string;
  exp: number; // unix seconds
}

/**
 * Safely extracts and decodes the payload of a JWT without verifying the signature
 * (signature verification is enforced by the backend on every API call).
 */
export function parseAccessTokenPayload(token: string): TokenPayload | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0]) return null;

  try {
    const base64Url: string = parts[0];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');

    let json: string;
    if (typeof atob === 'function') {
      json = atob(padded);
    } else if (typeof Buffer !== 'undefined') {
      json = Buffer.from(padded, 'base64').toString('utf8');
    } else {
      return null;
    }

    const payload = JSON.parse(json);
    if (
      typeof payload?.exp !== 'number' ||
      typeof payload?.userId !== 'string' ||
      typeof payload?.deviceId !== 'string'
    ) {
      return null;
    }

    return payload as TokenPayload;
  } catch {
    return null;
  }
}

/**
 * Returns true if the access token is missing, malformed, or will expire within bufferSeconds.
 * Defaults to a 15-second buffer to proactively prevent race conditions in flight.
 */
export function isAccessTokenExpired(token: string, bufferSeconds = 15): boolean {
  const payload = parseAccessTokenPayload(token);
  if (!payload) return true;
  const nowUnix = Math.floor(Date.now() / 1000);
  return nowUnix >= payload.exp - bufferSeconds;
}
