import { idbGet, idbSet } from '../storage/localDb';
import { getSafeErrorInfo, isTechnicalOrSensitive } from '../errors/safeErrors';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export async function getTokens(): Promise<TokenPair | null> {
  return idbGet<TokenPair>('auth:tokens');
}

export async function setTokens(tokens: TokenPair): Promise<void> {
  await idbSet('auth:tokens', tokens);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

let refreshPromise: Promise<TokenPair | null> | null = null;

// Fired when an authenticated call gets a 401 AND the follow-up refresh
// attempt itself fails — i.e. the refresh token is expired, revoked, or
// simply gone, not a transient blip. Previously nothing ever observed
// this: every authenticated call site just saw its own ApiError(401,...)
// in isolation and had no way to tell "this one request failed" apart
// from "this session is actually dead," so a revoked-while-offline or
// naturally-expired (30 day) session left every subsequent screen
// silently re-failing its own calls forever, with no path back to
// /login short of a manual, uninstructed logout. AuthContext registers
// a handler here (the layer that actually owns navigation/local-state
// teardown) rather than this module importing AuthContext directly and
// creating a circular dependency between the two.
let onSessionExpired: (() => void) | null = null;

export function setSessionExpiredHandler(handler: (() => void) | null): void {
  onSessionExpired = handler;
}

async function refreshTokens(): Promise<TokenPair | null> {
  const current = await getTokens();
  if (!current) return null;
  const res = await fetch(`${API_BASE}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: current.refreshToken }),
  });
  if (!res.ok) return null;
  const tokens = await res.json();
  await setTokens(tokens);
  return tokens;
}

interface ApiOptions {
  method?: string;
  body?: unknown;
  rawBody?: BodyInit;
  authenticated?: boolean;
}

export async function uploadAttachment(
  conversationId: string,
  bytes: Uint8Array,
  mimeTypeHint: 'image' | 'file',
  originalSize: number,
): Promise<{ attachmentId: string }> {
  const tokens = await getTokens();
  let res: Response;
  try {
    res = await fetch(
      `${API_BASE}/api/attachments/upload?conversationId=${encodeURIComponent(conversationId)}&mimeTypeHint=${mimeTypeHint}&originalSize=${originalSize}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          ...(tokens ? { Authorization: `Bearer ${tokens.accessToken}` } : {}),
        },
        body: bytes as BodyInit,
      },
    );
  } catch {
    throw new ApiError(503, 'Could not connect to server for upload. Please try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const rawMsg = data.error || 'Upload failed';
    throw new ApiError(res.status, isTechnicalOrSensitive(rawMsg) ? 'Upload failed. Please try again.' : rawMsg);
  }
  return data;
}

export async function downloadAttachment(attachmentId: string): Promise<Uint8Array> {
  const tokens = await getTokens();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/attachments/${attachmentId}`, {
      headers: tokens ? { Authorization: `Bearer ${tokens.accessToken}` } : {},
    });
  } catch {
    throw new ApiError(503, 'Could not connect to server for download. Please try again.');
  }
  if (!res.ok) throw new ApiError(res.status, 'Download failed');
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Every write path in the app goes through here so token refresh and
 * error shape are handled in one place. Deliberately does not distinguish
 * "user doesn't exist" from "wrong password" etc. in how it surfaces
 * errors — the backend already collapses those; this passes safe messages
 * through while sanitizing any technical or database leaks.
 */
export async function api<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
  const { method = 'GET', body, rawBody, authenticated = true } = options;

  async function doFetch(): Promise<Response> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (authenticated) {
      const tokens = await getTokens();
      if (tokens) headers['Authorization'] = `Bearer ${tokens.accessToken}`;
    }
    return fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
  }

  let res: Response;
  try {
    res = await doFetch();
  } catch (err) {
    if (typeof window !== 'undefined' && typeof navigator !== 'undefined' && navigator.onLine === false) {
      throw new ApiError(0, 'You appear to be offline. Check your connection and try again.');
    }
    throw new ApiError(503, 'Could not connect to Pookie Chat. Please check your connection and try again.');
  }

  if (res.status === 401 && authenticated) {
    // Coalesce concurrent refreshes into one request rather than a
    // stampede if several calls 401 at once.
    if (!refreshPromise) refreshPromise = refreshTokens().finally(() => (refreshPromise = null));
    const refreshed = await refreshPromise;
    if (refreshed) {
      try {
        res = await doFetch();
      } catch {
        throw new ApiError(503, 'Could not connect to Pookie Chat. Please check your connection and try again.');
      }
    } else {
      // The access token is dead AND the refresh token can't replace it
      // — a genuinely expired/revoked session, not a one-off failure.
      // Only fires once refresh is attempted and fails, never on a bare
      // 401 alone, so an isolated transient 401 (before this branch even
      // runs) doesn't force a logout it shouldn't.
      onSessionExpired?.();
    }
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const rawMsg = (data as { error?: string; message?: string }).error || (data as any).message || 'Request failed';
    const safeMsg = isTechnicalOrSensitive(rawMsg)
      ? getSafeErrorInfo({ status: res.status }).message
      : rawMsg;
    throw new ApiError(res.status, safeMsg);
  }
  return data as T;
}
