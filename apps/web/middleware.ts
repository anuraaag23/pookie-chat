import { NextRequest, NextResponse } from 'next/server';
import { isProtectedRoute, AUTH_COOKIE_NAME } from './lib/auth/routeGuards';

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  // Enforce centralized route protection at the edge / network boundary:
  // Redirect unauthenticated requests to /login before any private HTML or JS is served.
  if (isProtectedRoute(pathname)) {
    const hasAuthCookie = request.cookies.get(AUTH_COOKIE_NAME)?.value === '1';
    if (!hasAuthCookie) {
      const redirectUrl = new URL('/login', request.url);
      const fullTarget = pathname + (search || '');
      redirectUrl.searchParams.set('next', fullTarget);
      return NextResponse.redirect(redirectUrl);
    }
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const isDev = process.env.NODE_ENV === 'development';

  const apiOrigin = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
  const wsOrigin = apiOrigin.replace(/^http/, 'ws');

  // Script-src:
  // - In production: 'self', 'nonce-${nonce}', 'strict-dynamic' (strictly free of unsafe-inline and unsafe-eval)
  // - In development: 'self', 'nonce-${nonce}', 'strict-dynamic', 'unsafe-eval' (required for React Dev / Fast Refresh)
  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    ...(isDev ? ["'unsafe-eval'"] : []),
  ].join(' ');

  const cspHeader = [
    "default-src 'self'",
    `script-src ${scriptSrc} https://accounts.google.com/gsi/client`,
    "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
    "img-src 'self' data: blob: https://*.googleusercontent.com",
    `connect-src 'self' ${apiOrigin} ${wsOrigin} https://accounts.google.com/gsi/`,
    "frame-src 'self' https://accounts.google.com/gsi/",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self' https://accounts.google.com/",
  ].join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', cspHeader);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  response.headers.set('Content-Security-Policy', cspHeader);
  response.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api (API routes)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
