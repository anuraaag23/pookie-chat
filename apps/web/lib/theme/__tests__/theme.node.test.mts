import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('Theme System: globals.css defines both light (:root) and dark ([data-theme="dark"]) tokens', () => {
  const cssPath = path.resolve(process.cwd(), 'apps/web/app/globals.css');
  const css = fs.readFileSync(cssPath, 'utf8');
  assert.ok(css.includes(':root'), ':root light tokens missing in globals.css');
  assert.ok(css.includes("[data-theme='dark']"), 'dark theme selector missing in globals.css');
  assert.ok(css.includes('--surface: #1c1d22'), 'dark --surface token missing');
  assert.ok(css.includes('--text: #f2f2f5'), 'dark --text token missing');
});

test('Theme System: ThemeProvider and ThemeToggle are properly implemented', () => {
  const contextPath = path.resolve(process.cwd(), 'apps/web/lib/theme/ThemeContext.tsx');
  const togglePath = path.resolve(process.cwd(), 'apps/web/components/ui/ThemeToggle.tsx');
  assert.ok(fs.existsSync(contextPath), 'ThemeContext.tsx exists');
  assert.ok(fs.existsSync(togglePath), 'ThemeToggle.tsx exists');

  const contextCode = fs.readFileSync(contextPath, 'utf8');
  assert.ok(contextCode.includes('ThemeProvider'), 'ThemeProvider exported');
  assert.ok(contextCode.includes('useTheme'), 'useTheme exported');
  assert.ok(contextCode.includes('data-theme'), 'synchronizes data-theme attribute');
  assert.ok(contextCode.includes('localStorage'), 'persists to localStorage');

  const toggleCode = fs.readFileSync(togglePath, 'utf8');
  assert.ok(toggleCode.includes('aria-label'), 'ThemeToggle has aria-label');
  assert.ok(toggleCode.includes('focus-visible:outline'), 'ThemeToggle has visible focus indicator');
  assert.ok(toggleCode.includes('type="button"'), 'ThemeToggle is real button');
});

test('Login Page: Fixed viewport and no-scroll layout invariants', () => {
  const loginPath = path.resolve(process.cwd(), 'apps/web/app/login/page.tsx');
  const loginCode = fs.readFileSync(loginPath, 'utf8');

  // Must not have min-h-screen which causes vertical scrolling
  assert.ok(!loginCode.includes('min-h-screen'), 'LoginPage should not use min-h-screen');

  // Must have fixed viewport h-[100dvh] max-h-[100dvh] overflow-hidden
  assert.ok(loginCode.includes('h-[100dvh]'), 'LoginPage uses h-[100dvh]');
  assert.ok(loginCode.includes('max-h-[100dvh]'), 'LoginPage uses max-h-[100dvh]');
  assert.ok(loginCode.includes('overflow-hidden'), 'LoginPage uses overflow-hidden');

  // Must include ThemeToggle in header
  assert.ok(loginCode.includes('<ThemeToggle'), 'LoginPage includes ThemeToggle');

  // Divider uses bg-surface (not unmapped bg-surface-1)
  assert.ok(!loginCode.includes('bg-surface-1'), 'LoginPage does not use unmapped bg-surface-1');
  assert.ok(loginCode.includes('bg-surface'), 'LoginPage uses bg-surface');
});

test('Login Page: Keyboard accessibility and ARIA attributes', () => {
  const loginPath = path.resolve(process.cwd(), 'apps/web/app/login/page.tsx');
  const loginCode = fs.readFileSync(loginPath, 'utf8');

  // Input labels & accessibility
  assert.ok(loginCode.includes('id="login-identifier"'), 'Identifier input has id');
  assert.ok(loginCode.includes('aria-label="Username or email"'), 'Identifier input has aria-label');
  assert.ok(loginCode.includes('id="login-password"'), 'Password input has id');
  assert.ok(loginCode.includes('aria-label="Password"'), 'Password input has aria-label');

  // Password visibility toggle accessibility
  assert.ok(loginCode.includes('showPassword ?'), 'Password toggle has accessible label');
  assert.ok(loginCode.includes('focus-visible:outline'), 'Password toggle has focus-visible outline');

  // Error alerts accessibility
  assert.ok(loginCode.includes('role="alert"'), 'Error messages announce via role=alert');
  assert.ok(loginCode.includes('aria-live="polite"'), 'Error messages use aria-live');

  // Links have visible focus styling
  assert.ok(loginCode.includes('Terms of Service'), 'Terms of Service link present');
  assert.ok(loginCode.includes('Privacy Policy'), 'Privacy Policy link present');
  assert.ok(loginCode.includes('PublicFooter compact'), 'Uses compact PublicFooter');
});

test('NeoInput: Visible keyboard focus indicator', () => {
  const inputPath = path.resolve(process.cwd(), 'apps/web/components/ui/NeoInput.tsx');
  const inputCode = fs.readFileSync(inputPath, 'utf8');
  assert.ok(inputCode.includes('focus-visible:outline'), 'NeoInput has focus-visible outline');
});
