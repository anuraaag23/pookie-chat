import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

test('Capture Protection & Privacy Screen: Window blur and visibility change handlers exist', () => {
  const compPath = path.resolve(process.cwd(), 'apps/web/lib/security/CaptureProtection.tsx');
  const code = fs.readFileSync(compPath, 'utf8');

  // Verify blur and focus event listeners
  assert.ok(code.includes("window.addEventListener('blur', handleWindowBlur)"), 'Must attach window blur listener');
  assert.ok(code.includes("window.addEventListener('focus', handleWindowFocus)"), 'Must attach window focus listener');
  assert.ok(code.includes("document.addEventListener('visibilitychange', handleVisibilityChange)"), 'Must attach visibility listener');

  // Verify cleanup on unmount
  assert.ok(code.includes("window.removeEventListener('blur', handleWindowBlur)"), 'Must remove window blur listener');
  assert.ok(code.includes("window.removeEventListener('focus', handleWindowFocus)"), 'Must remove window focus listener');

  // Verify PrintScreen interception
  assert.ok(code.includes("'PrintScreen'"), 'Must intercept PrintScreen');

  // Verify visual blur overlay
  assert.ok(code.includes('backdrop-blur-3xl') || code.includes('backdrop-blur-2xl'), 'Must apply backdrop blur');
  assert.ok(code.includes('Pookie Chat is Secured'), 'Must render secured brand overlay');
});

test('Capture Protection: Settings page exposes Privacy Screen toggle', () => {
  const settingsPath = path.resolve(process.cwd(), 'apps/web/app/settings/page.tsx');
  const code = fs.readFileSync(settingsPath, 'utf8');

  assert.ok(code.includes('Privacy Screen & App Switcher Blur'), 'Settings must include Privacy Screen toggle');
  assert.ok(code.includes('screenshotProtectionEnabled'), 'Must bind to screenshotProtectionEnabled setting');
});
