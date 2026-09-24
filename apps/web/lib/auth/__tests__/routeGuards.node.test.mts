import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  isPublicRoute,
  isProtectedRoute,
  getSafeNextUrl,
  PUBLIC_ROUTES,
  PROTECTED_PREFIXES,
} from '../routeGuards.ts';
import {
  parseAccessTokenPayload,
  isAccessTokenExpired,
} from '../tokenValidation.ts';

test('Route Guards: Public routes are recognized and not protected', () => {
  assert.equal(isPublicRoute('/'), true);
  assert.equal(isPublicRoute('/login'), true);
  assert.equal(isPublicRoute('/register'), true);
  assert.equal(isPublicRoute('/privacy'), true);
  assert.equal(isPublicRoute('/terms'), true);
  assert.equal(isPublicRoute('/support'), true);

  assert.equal(isProtectedRoute('/'), false);
  assert.equal(isProtectedRoute('/login'), false);
  assert.equal(isProtectedRoute('/register'), false);
  assert.equal(isProtectedRoute('/privacy'), false);
  assert.equal(isProtectedRoute('/terms'), false);
  assert.equal(isProtectedRoute('/support'), false);
});

test('Route Guards: Authenticated routes are strictly protected', () => {
  assert.equal(isProtectedRoute('/chat'), true);
  assert.equal(isProtectedRoute('/chat/'), true);
  assert.equal(isProtectedRoute('/chat/conversation-123'), true);
  assert.equal(isProtectedRoute('/chat/c_abcdef123456'), true);
  assert.equal(isProtectedRoute('/connect'), true);
  assert.equal(isProtectedRoute('/connect/'), true);
  assert.equal(isProtectedRoute('/settings'), true);
  assert.equal(isProtectedRoute('/settings/'), true);

  // Future unlisted application pages are closed-by-default
  assert.equal(isProtectedRoute('/profile'), true);
  assert.equal(isProtectedRoute('/security'), true);

  assert.equal(isPublicRoute('/chat'), false);
  assert.equal(isPublicRoute('/connect'), false);
  assert.equal(isPublicRoute('/settings'), false);
});

test('Route Guards: Static assets and internals are never protected', () => {
  assert.equal(isProtectedRoute('/_next/static/chunks/main.js'), false);
  assert.equal(isProtectedRoute('/favicon.ico'), false);
  assert.equal(isProtectedRoute('/icon.png'), false);
  assert.equal(isProtectedRoute('/apple-icon.png'), false);
  assert.equal(isProtectedRoute('/logo.png'), false);
  assert.equal(isProtectedRoute('/api/auth/login'), false);
});

test('Safe Redirects: getSafeNextUrl allows safe internal relative paths', () => {
  assert.equal(getSafeNextUrl('/chat'), '/chat');
  assert.equal(getSafeNextUrl('/chat/abc-123'), '/chat/abc-123');
  assert.equal(getSafeNextUrl('/connect'), '/connect');
  assert.equal(getSafeNextUrl('/settings'), '/settings');
  assert.equal(getSafeNextUrl('/chat?filter=unread'), '/chat?filter=unread');
});

test('Safe Redirects: getSafeNextUrl rejects open redirect attacks and loops', () => {
  // Protocol-relative URLs
  assert.equal(getSafeNextUrl('//evil.com'), '/chat');
  assert.equal(getSafeNextUrl('//evil.com/chat'), '/chat');

  // External absolute URLs
  assert.equal(getSafeNextUrl('https://evil.com'), '/chat');
  assert.equal(getSafeNextUrl('http://attacker.com/chat'), '/chat');

  // JavaScript URIs
  assert.equal(getSafeNextUrl('javascript:alert(1)'), '/chat');

  // Windows backslash evasion
  assert.equal(getSafeNextUrl('\\evil.com'), '/chat');
  assert.equal(getSafeNextUrl('/\\evil.com'), '/chat');

  // Auth loops
  assert.equal(getSafeNextUrl('/login'), '/chat');
  assert.equal(getSafeNextUrl('/register'), '/chat');

  // Empty or invalid input
  assert.equal(getSafeNextUrl(''), '/chat');
  assert.equal(getSafeNextUrl(null), '/chat');
  assert.equal(getSafeNextUrl(undefined), '/chat');
});

test('Token Validation: parseAccessTokenPayload parses unexpired JWT payload', () => {
  const futureExp = Math.floor(Date.now() / 1000) + 900; // +15 min
  const rawPayload = JSON.stringify({ userId: 'u-1', deviceId: 'd-1', exp: futureExp });
  const base64Url = Buffer.from(rawPayload).toString('base64url');
  const dummyToken = `${base64Url}.fakeSignatureHash123`;

  const parsed = parseAccessTokenPayload(dummyToken);
  assert.ok(parsed !== null, 'Payload was parsed');
  assert.equal(parsed?.userId, 'u-1');
  assert.equal(parsed?.deviceId, 'd-1');
  assert.equal(parsed?.exp, futureExp);

  assert.equal(isAccessTokenExpired(dummyToken), false);
});

test('Token Validation: isAccessTokenExpired correctly detects expired tokens', () => {
  const pastExp = Math.floor(Date.now() / 1000) - 60; // 1 min in the past
  const rawPayload = JSON.stringify({ userId: 'u-1', deviceId: 'd-1', exp: pastExp });
  const base64Url = Buffer.from(rawPayload).toString('base64url');
  const expiredToken = `${base64Url}.fakeSignatureHash123`;

  assert.equal(isAccessTokenExpired(expiredToken), true);
  assert.equal(isAccessTokenExpired(''), true);
  assert.equal(isAccessTokenExpired('not-a-token'), true);
});

test('Edge Middleware Integration: middleware.ts enforces edge route protection', () => {
  const mwPath = path.resolve(process.cwd(), 'apps/web/middleware.ts');
  assert.ok(fs.existsSync(mwPath), 'middleware.ts exists');
  const code = fs.readFileSync(mwPath, 'utf8');

  assert.ok(code.includes('isProtectedRoute'), 'middleware imports isProtectedRoute');
  assert.ok(code.includes('AUTH_COOKIE_NAME'), 'middleware imports AUTH_COOKIE_NAME');
  assert.ok(code.includes('NextResponse.redirect'), 'middleware redirects unauthenticated requests');
  assert.ok(code.includes("redirectUrl.searchParams.set('next'"), 'middleware sets next redirect param');
  assert.ok(code.includes('Content-Security-Policy'), 'middleware maintains CSP protection');
  assert.ok(code.includes('Strict-Transport-Security'), 'middleware sets HSTS');
  assert.ok(code.includes('X-Content-Type-Options'), 'middleware sets X-Content-Type-Options');
  assert.ok(code.includes('Referrer-Policy'), 'middleware sets Referrer-Policy');
  assert.ok(code.includes('Permissions-Policy'), 'middleware sets Permissions-Policy');
});

test('SEC-H02: next.config.js configures production security headers centrally', () => {
  const cfgPath = path.resolve(process.cwd(), 'apps/web/next.config.js');
  assert.ok(fs.existsSync(cfgPath), 'next.config.js exists');
  const code = fs.readFileSync(cfgPath, 'utf8');

  assert.ok(code.includes('Strict-Transport-Security'), 'next.config sets HSTS');
  assert.ok(code.includes('max-age=63072000; includeSubDomains; preload'), 'HSTS max-age is 2 years with preload');
  assert.ok(code.includes('X-Content-Type-Options'), 'next.config sets X-Content-Type-Options');
  assert.ok(code.includes('nosniff'), 'nosniff enforced');
  assert.ok(code.includes('Referrer-Policy'), 'next.config sets Referrer-Policy');
  assert.ok(code.includes('strict-origin-when-cross-origin'), 'Referrer-Policy set to strict-origin-when-cross-origin');
  assert.ok(code.includes('Permissions-Policy'), 'next.config sets Permissions-Policy');
  assert.ok(code.includes('camera=(), microphone=(), geolocation=()'), 'Permissions-Policy restricts unused capabilities');
});

test('Client AuthGate Integration: AuthGate wraps layout and blocks unauthenticated content', () => {
  const gatePath = path.resolve(process.cwd(), 'apps/web/components/auth/AuthGate.tsx');
  assert.ok(fs.existsSync(gatePath), 'AuthGate.tsx exists');
  const gateCode = fs.readFileSync(gatePath, 'utf8');

  assert.ok(gateCode.includes('usePathname'), 'AuthGate reads current pathname');
  assert.ok(gateCode.includes('isProtectedRoute'), 'AuthGate checks route protection');
  assert.ok(gateCode.includes('useAuth'), 'AuthGate reads auth state');
  assert.ok(gateCode.includes('router.replace'), 'AuthGate redirects unauthenticated users');
  assert.ok(gateCode.includes('PookieLogo'), 'AuthGate renders branded loading state');

  const layoutPath = path.resolve(process.cwd(), 'apps/web/app/layout.tsx');
  const layoutCode = fs.readFileSync(layoutPath, 'utf8');
  assert.ok(layoutCode.includes('<AuthGate>'), 'layout.tsx wraps children in AuthGate');
});

test('AuthContext Integration: Session cookie synchronization and token expiration validation', () => {
  const authPath = path.resolve(process.cwd(), 'apps/web/lib/auth/AuthContext.tsx');
  const code = fs.readFileSync(authPath, 'utf8');

  assert.ok(code.includes('setAuthCookie'), 'AuthContext calls setAuthCookie');
  assert.ok(code.includes('clearAuthCookie'), 'AuthContext calls clearAuthCookie');
  assert.ok(code.includes('isAccessTokenExpired'), 'AuthContext validates access token freshness');
  assert.ok(code.includes('refreshTokens'), 'AuthContext proactively refreshes expired tokens');
});

test('Login Page Integration: Safe next destination handling and Suspense wrapping', () => {
  const loginPath = path.resolve(process.cwd(), 'apps/web/app/login/page.tsx');
  const code = fs.readFileSync(loginPath, 'utf8');

  assert.ok(code.includes('getSafeNextUrl'), 'Login page imports getSafeNextUrl');
  assert.ok(code.includes('useSearchParams'), 'Login page inspects query parameters');
  assert.ok(code.includes('safeTarget'), 'Login page redirects to safeTarget');
  assert.ok(code.includes('<Suspense'), 'Login page wraps form in Suspense');
});
