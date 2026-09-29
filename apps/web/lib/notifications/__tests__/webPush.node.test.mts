import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

test('Web Push: Service Worker file exists with push and notificationclick handlers', () => {
  const swPath = path.resolve(process.cwd(), 'apps/web/public/sw.js');
  assert.ok(fs.existsSync(swPath), 'public/sw.js must exist');

  const swCode = fs.readFileSync(swPath, 'utf8');
  assert.ok(swCode.includes("self.addEventListener('push'"), 'Must handle push event');
  assert.ok(swCode.includes("self.addEventListener('notificationclick'"), 'Must handle notificationclick event');
  assert.ok(swCode.includes('showNotification'), 'Must call showNotification');
  assert.ok(swCode.includes('/icon-192.png'), 'Must use official icon');
  assert.ok(swCode.includes('/badge.png'), 'Must use official badge');
});

test('Web Push: Client helper functions exist and handle non-browser environments gracefully', async () => {
  const helperPath = path.resolve(process.cwd(), 'apps/web/lib/notifications/webPush.ts');
  assert.ok(fs.existsSync(helperPath), 'webPush.ts must exist');

  const { isPushSupported, getNotificationPermission, registerServiceWorker } = await import('../webPush.ts');

  assert.equal(typeof isPushSupported, 'function');
  assert.equal(typeof getNotificationPermission, 'function');

  // In Node.js testing environment (no window), helpers must not crash and return safe defaults
  assert.equal(isPushSupported(), false);
  assert.equal(getNotificationPermission(), 'default');

  const reg = await registerServiceWorker();
  assert.equal(reg, null);
});

test('Web Push: Settings page exposes Web Push controls and test alert button', () => {
  const settingsPath = path.resolve(process.cwd(), 'apps/web/app/settings/page.tsx');
  const code = fs.readFileSync(settingsPath, 'utf8');

  assert.ok(code.includes('Web Push Notifications'), 'Settings must display Web Push title');
  assert.ok(code.includes('requestNotificationPermission'), 'Settings must allow requesting permissions');
  assert.ok(code.includes('Test Alert'), 'Settings must allow testing alerts');
});
