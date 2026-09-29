import { idbGet, idbSet } from '../storage/localDb.ts';
import { getSafeErrorInfo, isTechnicalOrSensitive } from '../errors/safeErrors.ts';
import { isAccessTokenExpired } from '../auth/tokenValidation.ts';

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
  public status: number;
  public requiresTurnstile?: boolean;
  public data?: any;

  constructor(
    status: number,
    message: string,
    data?: any,
  ) {
    super(message);
    this.status = status;
    this.data = data;
    if (data && typeof data === 'object' && (data as any).requiresTurnstile) {
      this.requiresTurnstile = true;
    }
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

export async function refreshTokens(): Promise<TokenPair | null> {
  const current = await getTokens();
  if (!current || !current.refreshToken) return null;

  const executeRefresh = async (): Promise<TokenPair | null> => {
    // Check if another tab has already rotated tokens
    const latest = await getTokens();
    if (latest && latest.refreshToken !== current.refreshToken && latest.accessToken) {
      return latest;
    }

    let res: Response;
    try {
      res = await fetch(`${API_BASE}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      });
    } catch (err) {
      // Network error (offline, connection aborted, etc.) — throw so caller does NOT wipe session
      throw new ApiError(503, 'Could not connect to Pookie Chat. Please check your connection and try again.');
    }

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        // Re-check: did another tab write new tokens just before this request?
        const check = await getTokens();
        if (check && check.refreshToken !== current.refreshToken && check.accessToken) {
          return check;
        }
        return null; // Session genuinely dead/revoked
      }
      // 500, 502, 503, 429 — server or gateway error, NOT a dead session
      throw new ApiError(res.status, 'Refresh service temporarily unavailable.');
    }

    const tokens: TokenPair = await res.json();
    await setTokens(tokens);
    return tokens;
  };

  // Cross-tab synchronization via Web Locks API when available
  if (typeof navigator !== 'undefined' && 'locks' in navigator && (navigator.locks as any)?.request) {
    return (navigator.locks as any).request('pookie_auth_refresh', async () => {
      return executeRefresh();
    });
  }

  return executeRefresh();
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
  let tokens = await getTokens();
  if (tokens?.accessToken && isAccessTokenExpired(tokens.accessToken)) {
    try {
      tokens = await refreshTokens();
    } catch {
      // Best-effort refresh; continue with existing tokens
    }
  }

  const url = `${API_BASE}/api/attachments/upload?conversationId=${encodeURIComponent(conversationId)}&mimeTypeHint=${mimeTypeHint}&originalSize=${originalSize}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        ...(tokens?.accessToken ? { Authorization: `Bearer ${tokens.accessToken}` } : {}),
      },
      body: bytes as BodyInit,
    });
  } catch {
    throw new ApiError(503, 'Could not connect to server for upload. Please try again.');
  }

  // Auto-retry once on 401 if refresh succeeds
  if (res.status === 401) {
    try {
      const refreshed = await refreshTokens();
      if (refreshed?.accessToken) {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            Authorization: `Bearer ${refreshed.accessToken}`,
          },
          body: bytes as BodyInit,
        });
      }
    } catch {
      // Fall through to error handler
    }
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const rawMsg = data.error || data.message || 'Upload failed';
    throw new ApiError(res.status, isTechnicalOrSensitive(rawMsg) ? 'Upload failed. Please try again.' : rawMsg);
  }
  return data;
}

export async function downloadAttachment(attachmentId: string): Promise<Uint8Array> {
  let tokens = await getTokens();
  if (tokens?.accessToken && isAccessTokenExpired(tokens.accessToken)) {
    try {
      tokens = await refreshTokens();
    } catch {
      // Best-effort
    }
  }

  const url = `${API_BASE}/api/attachments/${attachmentId}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: tokens?.accessToken ? { Authorization: `Bearer ${tokens.accessToken}` } : {},
    });
  } catch {
    throw new ApiError(503, 'Could not connect to server for download. Please try again.');
  }

  if (res.status === 401) {
    try {
      const refreshed = await refreshTokens();
      if (refreshed?.accessToken) {
        res = await fetch(url, {
          headers: { Authorization: `Bearer ${refreshed.accessToken}` },
        });
      }
    } catch {
      // Fall through
    }
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
      body: rawBody ?? (body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined),
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
    try {
      const refreshed = await refreshPromise;
      if (refreshed) {
        try {
          res = await doFetch();
        } catch {
          throw new ApiError(503, 'Could not connect to Pookie Chat. Please check your connection and try again.');
        }
      } else {
        // The access token is dead AND the server explicitly rejected the refresh token (401/403)
        // — a genuinely expired or revoked session.
        onSessionExpired?.();
      }
    } catch {
      // Network error or temporary server hiccup during refresh — do NOT expire session!
      throw new ApiError(503, 'Could not connect to Pookie Chat. Please check your connection and try again.');
    }
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const rawMsg = Array.isArray((data as any).message)
      ? (data as any).message.join(', ')
      : (data as any).message || (data as { error?: string }).error || 'Request failed';
    const safeMsg = isTechnicalOrSensitive(rawMsg)
      ? getSafeErrorInfo({ status: res.status }).message
      : rawMsg;
    throw new ApiError(res.status, safeMsg, data);
  }
  return data as T;
}
