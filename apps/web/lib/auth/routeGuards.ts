/**
 * Centralized Route & Authorization Utilities
 *
 * Defines single sources of truth for:
 * - Public routes: accessible without login (/, /login, /register, /privacy, /terms, /support)
 * - Protected routes: /chat, /chat/*, /connect, /settings, and future private routes
 * - Safe internal redirect validation (preventing open redirect vulnerabilities)
 * - Lightweight auth session cookie management for Edge Middleware inspection
 */

export const PUBLIC_ROUTES = [
  '/',
  '/login',
  '/register',
  '/privacy',
  '/terms',
  '/support',
] as const;

export const PROTECTED_PREFIXES = [
  '/chat',
  '/connect',
  '/settings',
] as const;

export const AUTH_COOKIE_NAME = 'pookie_auth';

function cleanPath(pathname: string): string {
  const qIdx = pathname.indexOf('?');
  const withoutQ = qIdx >= 0 ? pathname.slice(0, qIdx) : pathname;
  const hIdx = withoutQ.indexOf('#');
  const clean = hIdx >= 0 ? withoutQ.slice(0, hIdx) : withoutQ;
  return clean || '/';
}

/**
 * Checks if a given pathname is explicitly public.
 */
export function isPublicRoute(pathname: string): boolean {
  const normalized = cleanPath(pathname);
  return PUBLIC_ROUTES.some((route) => normalized === route);
}

/**
 * Checks if a given pathname requires authentication.
 * Any route starting with /chat, /connect, /settings or any route that is NOT public
 * is classified as protected. Static assets and internal next paths are ignored.
 */
export function isProtectedRoute(pathname: string): boolean {
  const normalized = cleanPath(pathname);

  // Never protect Next.js internals, API routes, or public static assets
  if (
    normalized.startsWith('/_next') ||
    normalized.startsWith('/api') ||
    normalized.includes('.') // static files like favicon.ico, logo.png, etc.
  ) {
    return false;
  }

  // Explicitly public routes are never protected
  if (isPublicRoute(normalized)) {
    return false;
  }

  // Any protected prefix is protected
  if (PROTECTED_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))) {
    return true;
  }

  // Default closed: unlisted non-public application routes are protected
  return true;
}

/**
 * Validates and sanitizes a 'next' query parameter to ensure it is a safe internal relative path.
 * Defends against open-redirect vulnerabilities (e.g., //evil.com, https://evil.com, javascript:).
 */
export function getSafeNextUrl(rawNext: string | null | undefined, fallback = '/chat'): string {
  if (!rawNext || typeof rawNext !== 'string') {
    return fallback;
  }

  const trimmed = rawNext.trim();

  // Must begin with a single '/', not '//' (protocol-relative) and not '\' (Windows path tricks)
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('\\')) {
    return fallback;
  }

  // Must not contain scheme delimiter
  if (trimmed.includes('://')) {
    return fallback;
  }

  // Prevent redirect loops back to auth pages
  const normalizedPath = cleanPath(trimmed);
  if (normalizedPath === '/login' || normalizedPath === '/register') {
    return fallback;
  }

  return trimmed;
}

/**
 * Sets the lightweight auth cookie for Edge Middleware inspection.
 * This cookie does not contain sensitive tokens (those remain securely in IndexedDB),
 * but informs Edge Middleware that an active authenticated session exists.
 */
export function setAuthCookie(): void {
  if (typeof document === 'undefined') return;
  const isSecure = typeof window !== 'undefined' && window.location.protocol === 'https:';
  // 30 days matching maximum refresh token lifetime
  const maxAge = 30 * 24 * 60 * 60;
  document.cookie = `${AUTH_COOKIE_NAME}=1; Path=/; SameSite=Lax; Max-Age=${maxAge}${isSecure ? '; Secure' : ''}`;
}

/**
 * Clears the lightweight auth cookie on logout or session expiration.
 */
export function clearAuthCookie(): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${AUTH_COOKIE_NAME}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax`;
}
