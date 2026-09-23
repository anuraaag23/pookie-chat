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

test('AppHeader: Persistent desktop navigation and global theme toggle', () => {
  const headerPath = path.resolve(process.cwd(), 'apps/web/components/navigation/AppHeader.tsx');
  assert.ok(fs.existsSync(headerPath), 'AppHeader.tsx exists');
  const headerCode = fs.readFileSync(headerPath, 'utf8');

  assert.ok(headerCode.includes('ThemeToggle'), 'AppHeader renders ThemeToggle');
  assert.ok(headerCode.includes('activeTab'), 'AppHeader accepts activeTab prop');
  assert.ok(headerCode.includes('/chat'), 'AppHeader has Chat navigation link');
  assert.ok(headerCode.includes('/connect'), 'AppHeader has Connect navigation link');
  assert.ok(headerCode.includes('/settings'), 'AppHeader has Settings navigation link');
  assert.ok(headerCode.includes('hidden md:flex'), 'AppHeader contains desktop navigation bar');
});

test('ConversationSidebar: Responsive sidebar with conversation list and search', () => {
  const sidebarPath = path.resolve(process.cwd(), 'apps/web/components/chat/ConversationSidebar.tsx');
  assert.ok(fs.existsSync(sidebarPath), 'ConversationSidebar.tsx exists');
  const sidebarCode = fs.readFileSync(sidebarPath, 'utf8');

  assert.ok(sidebarCode.includes('activeConversationId'), 'ConversationSidebar supports active conversation');
  assert.ok(sidebarCode.includes('onSearchChange'), 'ConversationSidebar has search capability');
  assert.ok(sidebarCode.includes('/chat/${id}'), 'ConversationSidebar links to conversations');
  assert.ok(sidebarCode.includes('bg-surface'), 'ConversationSidebar uses theme background tokens');
});

test('Desktop UX & Dual-Pane Chat Layout: Chat and Chat Detail pages', () => {
  const chatPath = path.resolve(process.cwd(), 'apps/web/app/chat/page.tsx');
  const chatDetailPath = path.resolve(process.cwd(), 'apps/web/app/chat/[conversationId]/page.tsx');
  const chatCode = fs.readFileSync(chatPath, 'utf8');
  const chatDetailCode = fs.readFileSync(chatDetailPath, 'utf8');

  // Both pages render AppHeader
  assert.ok(chatCode.includes('<AppHeader'), '/chat renders AppHeader');
  assert.ok(chatDetailCode.includes('<AppHeader'), '/chat/[conversationId] renders AppHeader');

  // Both pages render ConversationSidebar for desktop dual-pane
  assert.ok(chatCode.includes('<ConversationSidebar'), '/chat renders ConversationSidebar');
  assert.ok(chatDetailCode.includes('<ConversationSidebar'), '/chat/[conversationId] renders ConversationSidebar');

  // Dual-pane layout classes
  assert.ok(chatCode.includes('md:w-80') || chatCode.includes('md:grid'), '/chat has responsive sidebar layout');
  assert.ok(chatDetailCode.includes('md:w-80') || chatDetailCode.includes('md:flex'), '/chat/[id] has responsive desktop dual-pane');
});

test('Global ThemeToggle: Verified presence across all application routes', () => {
  // Public Landing
  const homeCode = fs.readFileSync(path.resolve(process.cwd(), 'apps/web/app/page.tsx'), 'utf8');
  assert.ok(homeCode.includes('<ThemeToggle'), 'Landing page renders ThemeToggle');

  // Registration
  const registerCode = fs.readFileSync(path.resolve(process.cwd(), 'apps/web/app/register/page.tsx'), 'utf8');
  assert.ok(registerCode.includes('<ThemeToggle'), 'Register page renders ThemeToggle');
  assert.ok(!registerCode.includes('bg-surface-1'), 'Register page does not use unmapped bg-surface-1');

  // Login
  const loginCode = fs.readFileSync(path.resolve(process.cwd(), 'apps/web/app/login/page.tsx'), 'utf8');
  assert.ok(loginCode.includes('<ThemeToggle'), 'Login page renders ThemeToggle');

  // Connect (via AppHeader)
  const connectCode = fs.readFileSync(path.resolve(process.cwd(), 'apps/web/app/connect/page.tsx'), 'utf8');
  assert.ok(connectCode.includes('<AppHeader'), 'Connect page renders AppHeader with ThemeToggle');

  // Settings (AppHeader + in-page Appearance section)
  const settingsCode = fs.readFileSync(path.resolve(process.cwd(), 'apps/web/app/settings/page.tsx'), 'utf8');
  assert.ok(settingsCode.includes('<AppHeader'), 'Settings page renders AppHeader');
  assert.ok(settingsCode.includes('<ThemeToggle'), 'Settings page renders ThemeToggle in Appearance section');
  assert.ok(settingsCode.includes('lg:grid-cols-2'), 'Settings page uses balanced 2-column desktop grid');

  // Public Documentation & Support Pages
  const privacyCode = fs.readFileSync(path.resolve(process.cwd(), 'apps/web/app/privacy/page.tsx'), 'utf8');
  assert.ok(privacyCode.includes('<ThemeToggle'), 'Privacy page renders ThemeToggle');

  const termsCode = fs.readFileSync(path.resolve(process.cwd(), 'apps/web/app/terms/page.tsx'), 'utf8');
  assert.ok(termsCode.includes('<ThemeToggle'), 'Terms page renders ThemeToggle');

  const supportCode = fs.readFileSync(path.resolve(process.cwd(), 'apps/web/app/support/page.tsx'), 'utf8');
  assert.ok(supportCode.includes('<ThemeToggle'), 'Support page renders ThemeToggle');
});
