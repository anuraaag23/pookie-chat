import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isTechnicalOrSensitive } from '../../errors/safeErrors.ts';

test('TurnstileWidget: Neomorphic styling, theme support, and accessibility', () => {
  const widgetPath = path.resolve(process.cwd(), 'apps/web/components/auth/TurnstileWidget.tsx');
  const code = fs.readFileSync(widgetPath, 'utf8');

  // Verify Neomorphic container
  assert.ok(code.includes('NeoSurface'), 'Wraps widget in NeoSurface component');
  assert.ok(code.includes('variant="pressed"'), 'Uses pressed Neomorphic styling');

  // Verify Cloudflare Turnstile script loading
  assert.ok(code.includes('challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'), 'Loads official Cloudflare Turnstile script');

  // Verify theme synchronization
  assert.ok(code.includes('useTheme()'), 'Reads current application theme');
  assert.ok(code.includes("theme === 'dark' ? 'dark' : 'light'"), 'Synchronizes dark/light theme with Turnstile');

  // Verify callbacks and lifecycle
  assert.ok(code.includes('callback:'), 'Turnstile callback registered for token delivery');
  assert.ok(code.includes('expired-callback'), 'Turnstile expired-callback registered');
  assert.ok(code.includes('error-callback'), 'Turnstile error-callback registered');
  assert.ok(code.includes('window.turnstile.remove'), 'Cleans up widget on unmount or reset');

  // Verify accessibility
  assert.ok(code.includes('aria-label="Security verification challenge"'), 'Accessibility label present on challenge region');
  assert.ok(code.includes('role="region"'), 'Region role declared');
  assert.ok(code.includes('role="alert"'), 'Accessible alert role on error states');

  // Verify safe error messages
  assert.ok(!code.includes('invalid-input-response'), 'No internal Cloudflare codes exposed in UI');
  assert.ok(!code.includes('secret'), 'Never references secrets in frontend component');
});

test('Registration Page: Turnstile integration and token submission', () => {
  const registerPath = path.resolve(process.cwd(), 'apps/web/app/register/page.tsx');
  const code = fs.readFileSync(registerPath, 'utf8');

  // Must import TurnstileWidget
  assert.ok(code.includes('import { TurnstileWidget } from'), 'Imports TurnstileWidget');

  // Must render TurnstileWidget with action="register"
  assert.ok(code.includes('<TurnstileWidget'), 'Renders TurnstileWidget component');
  assert.ok(code.includes('action="register"'), 'Configures action as register');

  // Token state and submission
  assert.ok(code.includes('const [turnstileToken, setTurnstileToken]'), 'Maintains turnstileToken state');
  assert.ok(code.includes("register(password, normalizedUsername, 'Web browser', emailInput, turnstileToken"), 'Submits turnstileToken with register call');

  // Single-use token clearing on retry/error
  assert.ok(code.includes('setTurnstileToken(null)'), 'Clears token on submission error');
  assert.ok(code.includes('setTurnstileResetCount'), 'Resets widget on retry');
});

test('Login Page: Conditional Turnstile challenge (hidden initially, shown on challenge)', () => {
  const loginPath = path.resolve(process.cwd(), 'apps/web/app/login/page.tsx');
  const code = fs.readFileSync(loginPath, 'utf8');

  // Must import TurnstileWidget
  assert.ok(code.includes('import { TurnstileWidget } from'), 'Imports TurnstileWidget');

  // Initially hidden: normal login has NO CAPTCHA
  assert.ok(code.includes('const [requiresTurnstile, setRequiresTurnstile] = useState(false)'), 'requiresTurnstile defaults to false');

  // Conditional render guard
  assert.ok(code.includes('{requiresTurnstile && ('), 'Turnstile is conditionally rendered only when challenged');
  assert.ok(code.includes('action="login"'), 'Configures action as login');

  // Backend challenge detection
  assert.ok(code.includes('e?.requiresTurnstile || e?.data?.requiresTurnstile'), 'Detects backend challenge from error response');
  assert.ok(code.includes('setRequiresTurnstile(true)'), 'Activates challenge state on server demand');

  // Submits turnstileToken with login
  assert.ok(code.includes("login(identifier.trim(), password, 'Web browser', turnstileToken"), 'Passes turnstileToken to login()');

  // Token clearing and retry reset
  assert.ok(code.includes('setTurnstileToken(null)'), 'Clears token after each attempt');
  assert.ok(code.includes('setTurnstileResetCount'), 'Resets Turnstile challenge widget on retry');

  // Disables submit when challenge is active and token not yet obtained
  assert.ok(code.includes('requiresTurnstile && !turnstileToken'), 'Blocks submission when challenge is pending');
});

test('CSP Configuration: Cloudflare Turnstile origins allowed in middleware', () => {
  const middlewarePath = path.resolve(process.cwd(), 'apps/web/middleware.ts');
  const code = fs.readFileSync(middlewarePath, 'utf8');

  // Must allow https://challenges.cloudflare.com in script-src, connect-src, frame-src
  assert.ok(code.includes('script-src ${scriptSrc} https://accounts.google.com/gsi/client https://challenges.cloudflare.com'), 'script-src allows Cloudflare Turnstile');
  assert.ok(code.includes("connect-src 'self' ${apiOrigin} ${wsOrigin} https://accounts.google.com/gsi/ https://challenges.cloudflare.com"), 'connect-src allows Cloudflare Turnstile');
  assert.ok(code.includes("frame-src 'self' https://accounts.google.com/gsi/ https://challenges.cloudflare.com"), 'frame-src allows Cloudflare Turnstile');

  // Must preserve strict-dynamic, nonce, and existing origins
  assert.ok(code.includes("'strict-dynamic'"), 'strict-dynamic preserved');
  assert.ok(code.includes("'nonce-"), 'per-request nonce preserved');
  assert.ok(code.includes("frame-ancestors 'none'"), 'frame-ancestors none preserved');
});

test('ApiError: client.ts defines requiresTurnstile property and forwards payload', () => {
  const clientPath = path.resolve(process.cwd(), 'apps/web/lib/api/client.ts');
  const code = fs.readFileSync(clientPath, 'utf8');

  assert.ok(code.includes('public requiresTurnstile?: boolean;'), 'ApiError defines requiresTurnstile property');
  assert.ok(code.includes('this.requiresTurnstile = true;'), 'ApiError extracts requiresTurnstile from payload');
  assert.ok(code.includes('new ApiError(res.status, safeMsg, data);'), 'api() passes data payload to ApiError');
});

test('Safe Errors: verification messages are not censored as technical/sensitive', () => {
  const safeMsgs = [
    'Security verification required. Please complete the challenge.',
    'Security verification failed. Please try again.',
    'Security verification expired. Please complete the challenge again.',
    'Security verification unavailable. Please try again in a few moments.',
    'Security verification is not configured on this server.',
  ];

  for (const msg of safeMsgs) {
    assert.equal(isTechnicalOrSensitive(msg), false, `"${msg}" must not be censored`);
  }
});
