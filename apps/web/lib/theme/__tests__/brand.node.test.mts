import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('Brand Identity: Official logo assets exist with appropriate sizes', () => {
  const root = process.cwd();
  const publicDir = path.resolve(root, 'apps/web/public');
  const appDir = path.resolve(root, 'apps/web/app');

  // Static assets
  assert.ok(fs.existsSync(path.join(publicDir, 'logo.png')), 'public/logo.png exists');
  assert.ok(fs.existsSync(path.join(publicDir, 'logo.jpg')), 'public/logo.jpg exists');
  assert.ok(fs.existsSync(path.join(publicDir, 'icon-512.png')), 'public/icon-512.png exists');
  assert.ok(fs.existsSync(path.join(publicDir, 'icon-192.png')), 'public/icon-192.png exists');
  assert.ok(fs.existsSync(path.join(publicDir, 'apple-touch-icon.png')), 'public/apple-touch-icon.png exists');
  assert.ok(fs.existsSync(path.join(publicDir, 'badge.png')), 'public/badge.png exists');
  assert.ok(fs.existsSync(path.join(publicDir, 'favicon.ico')), 'public/favicon.ico exists');

  // Next.js App Router route icons
  assert.ok(fs.existsSync(path.join(appDir, 'icon.png')), 'app/icon.png exists');
  assert.ok(fs.existsSync(path.join(appDir, 'apple-icon.png')), 'app/apple-icon.png exists');
  assert.ok(fs.existsSync(path.join(appDir, 'favicon.ico')), 'app/favicon.ico exists');
});

test('Brand Identity: Reusable PookieLogo component conforms to specifications', () => {
  const compPath = path.resolve(process.cwd(), 'apps/web/components/ui/PookieLogo.tsx');
  assert.ok(fs.existsSync(compPath), 'PookieLogo.tsx exists');
  const code = fs.readFileSync(compPath, 'utf8');

  assert.ok(code.includes('/logo.png'), 'PookieLogo references /logo.png');
  assert.ok(code.includes('SIZE_CONFIG'), 'PookieLogo has size configurations');
  assert.ok(code.includes('xs:'), 'Supports xs size');
  assert.ok(code.includes('sm:'), 'Supports sm size');
  assert.ok(code.includes('md:'), 'Supports md size');
  assert.ok(code.includes('lg:'), 'Supports lg size');
  assert.ok(code.includes('xl:'), 'Supports xl size');
  assert.ok(code.includes('aria-hidden='), 'PookieLogo handles decorative aria-hidden');
});

test('Brand Identity: Root layout metadata configures official brand icons', () => {
  const layoutPath = path.resolve(process.cwd(), 'apps/web/app/layout.tsx');
  const code = fs.readFileSync(layoutPath, 'utf8');

  assert.ok(code.includes('/favicon.ico'), 'metadata contains favicon.ico');
  assert.ok(code.includes('/icon-192.png'), 'metadata contains icon-192.png');
  assert.ok(code.includes('/icon-512.png'), 'metadata contains icon-512.png');
  assert.ok(code.includes('/apple-touch-icon.png'), 'metadata contains apple-touch-icon.png');
});

test('Brand Identity: AppHeader integrates official PookieLogo with accessible navigation link', () => {
  const headerPath = path.resolve(process.cwd(), 'apps/web/components/navigation/AppHeader.tsx');
  const code = fs.readFileSync(headerPath, 'utf8');

  assert.ok(code.includes('<PookieLogo'), 'AppHeader renders PookieLogo');
  assert.ok(code.includes('aria-label="Pookie Chat"'), 'AppHeader link has accessible brand label');
  assert.ok(code.includes('focus-visible:outline'), 'AppHeader brand link has focus indicator');
});

test('Brand Identity: Login and Register pages display unified official branding', () => {
  const loginCode = fs.readFileSync(path.resolve(process.cwd(), 'apps/web/app/login/page.tsx'), 'utf8');
  assert.ok(loginCode.includes('<PookieLogo'), 'Login page renders PookieLogo');

  const registerCode = fs.readFileSync(path.resolve(process.cwd(), 'apps/web/app/register/page.tsx'), 'utf8');
  assert.ok(registerCode.includes('<PookieLogo'), 'Register page renders PookieLogo');
});

test('Brand Identity: Landing page, loading screen, chat empty state, and error states display PookieLogo', () => {
  const homeCode = fs.readFileSync(path.resolve(process.cwd(), 'apps/web/app/page.tsx'), 'utf8');
  assert.ok(homeCode.includes('<PookieLogo'), 'Home page renders PookieLogo');

  const loadingCode = fs.readFileSync(path.resolve(process.cwd(), 'apps/web/app/loading.tsx'), 'utf8');
  assert.ok(loadingCode.includes('<PookieLogo'), 'Loading page renders PookieLogo');

  const chatCode = fs.readFileSync(path.resolve(process.cwd(), 'apps/web/app/chat/page.tsx'), 'utf8');
  assert.ok(chatCode.includes('<PookieLogo'), 'Chat page renders PookieLogo in empty state');

  const errorCode = fs.readFileSync(path.resolve(process.cwd(), 'apps/web/components/ui/ThemedErrorState.tsx'), 'utf8');
  assert.ok(errorCode.includes('<PookieLogo'), 'ThemedErrorState renders PookieLogo');
});

test('Brand Identity: Web Notifications use official icon and badge', () => {
  const chatDetailCode = fs.readFileSync(
    path.resolve(process.cwd(), 'apps/web/app/chat/[conversationId]/page.tsx'),
    'utf8'
  );
  assert.ok(chatDetailCode.includes("icon: '/icon-192.png'"), 'Notification uses official icon');
  assert.ok(chatDetailCode.includes("badge: '/badge.png'"), 'Notification uses official badge');
});
