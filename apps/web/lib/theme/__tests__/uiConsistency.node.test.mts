import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('Connect Page: Restored temporary durations (15m, 1h, 1d, 7d, 30d, 90d)', () => {
  const durationsPath = path.resolve(process.cwd(), 'apps/web/lib/pairing/durations.ts');
  const code = fs.readFileSync(durationsPath, 'utf8');

  // Verify TEMPORARY_DURATIONS array definition
  assert.ok(code.includes('export const TEMPORARY_DURATIONS'), 'TEMPORARY_DURATIONS exported');

  // All 6 required durations must exist
  const expectedLabels = ['15m', '1h', '1d', '7d', '30d', '90d'];
  for (const label of expectedLabels) {
    assert.ok(code.includes(`label: '${label}'`), `Duration ${label} must be present`);
  }

  // Verify seconds calculations
  assert.ok(code.includes('15 * 60'), '15m is 15 * 60s');
  assert.ok(code.includes('60 * 60'), '1h is 60 * 60s');
  assert.ok(code.includes('24 * 60 * 60'), '1d is 24 * 60 * 60s');
  assert.ok(code.includes('7 * 24 * 60 * 60'), '7d is 7 * 24 * 60 * 60s');
  assert.ok(code.includes('30 * 24 * 60 * 60'), '30d is 30 * 24 * 60 * 60s');
  assert.ok(code.includes('90 * 24 * 60 * 60'), '90d is 90 * 24 * 60 * 60s');
});

test('Connect Page: Neomorphic action buttons and responsive modal surfaces', () => {
  const connectPath = path.resolve(process.cwd(), 'apps/web/app/connect/page.tsx');
  const code = fs.readFileSync(connectPath, 'utf8');

  // Must use neo-raised and active:neo-pressed for buttons
  assert.ok(code.includes('neo-raised active:neo-pressed'), 'Action buttons use Neomorphic raised and pressed styles');
  assert.ok(code.includes('Connect with Code'), 'Connect with Code button present');
  assert.ok(code.includes('Generate Temporary Code'), 'Generate Temporary Code button present');
  assert.ok(code.includes('Find by Username'), 'Find by Username button present');

  // Modal / sheet dialog surfaces
  assert.ok(code.includes('role="dialog"'), 'Modals have accessible role="dialog"');
  assert.ok(code.includes('fixed inset-0 z-50 flex sm:items-center items-end'), 'Responsive viewport modal (desktop centered, mobile bottom sheet)');
  assert.ok(code.includes('aria-modal="true"'), 'Modals declare aria-modal="true"');
  assert.ok(code.includes("e.key === 'Escape'"), 'Escape key dismisses open modal surface');
});

test('Settings Page: Navigation restoration and mobile TabBar', () => {
  const settingsPath = path.resolve(process.cwd(), 'apps/web/app/settings/page.tsx');
  const code = fs.readFileSync(settingsPath, 'utf8');

  // Must render TabBar active="Settings"
  assert.ok(code.includes('<TabBar active="Settings" />'), 'Persistent mobile TabBar present in Settings');

  // Mobile detail back button
  assert.ok(code.includes('setMobileViewingCategory(false)'), 'Back button restores category navigation view on mobile');
  assert.ok(code.includes('Back to Settings'), 'Accessible back navigation label');
});

test('Settings Page: Themed Neomorphic logout confirmation modal', () => {
  const settingsPath = path.resolve(process.cwd(), 'apps/web/app/settings/page.tsx');
  const code = fs.readFileSync(settingsPath, 'utf8');

  // Themed confirmation dialog
  assert.ok(code.includes('showLogoutConfirm'), 'Logout confirmation state managed');
  assert.ok(code.includes('Log out of Pookie Chat?'), 'Themed confirmation modal header present');
  assert.ok(!code.includes('window.confirm'), 'Zero browser-native confirm() calls');
  assert.ok(!code.includes('confirm('), 'Zero browser-native confirm() calls');
  assert.ok(code.includes("accent=\"danger\""), 'Logout action uses danger accent');
});

test('Settings Page: Storage & Google Drive comprehensive status states', () => {
  const settingsPath = path.resolve(process.cwd(), 'apps/web/app/settings/page.tsx');
  const code = fs.readFileSync(settingsPath, 'utf8');

  // States A, B, C, D, E
  assert.ok(code.includes('Connected to your Google Drive'), 'State A: Connected handled');
  assert.ok(code.includes('Connect your Google Drive'), 'State B: Disconnected handled with explanation');
  assert.ok(code.includes('Server OAuth Unavailable'), 'State C: Server OAuth unconfigured explained');
  assert.ok(code.includes('Sign In Again'), 'State D: Session expired handled');
  assert.ok(code.includes('Retry Check'), 'State E: Retry button handled');
  assert.ok(code.includes('/api/storage/google-drive/connect'), 'Connects to correct storage endpoint');
});

test('Settings Page: Appearance accent swatches and ThemeContext color sync', () => {
  const settingsPath = path.resolve(process.cwd(), 'apps/web/app/settings/page.tsx');
  const code = fs.readFileSync(settingsPath, 'utf8');
  const themeContextPath = path.resolve(process.cwd(), 'apps/web/lib/theme/ThemeContext.tsx');
  const themeCode = fs.readFileSync(themeContextPath, 'utf8');

  // Settings displays color swatches
  assert.ok(code.includes('backgroundColor: opt.hex'), 'Visible color swatch circles rendered in settings');
  assert.ok(code.includes('setAccentColor'), 'Calls setAccentColor from ThemeContext');

  // ThemeContext synchronizes --blue CSS variable
  assert.ok(themeCode.includes('--blue'), 'ThemeContext updates --blue CSS custom property');
  assert.ok(themeCode.includes('pookie_accent'), 'ThemeContext persists accent in localStorage');
});

test('Settings Page: Grouped privacy controls with real persisted fields', () => {
  const settingsPath = path.resolve(process.cwd(), 'apps/web/app/settings/page.tsx');
  const code = fs.readFileSync(settingsPath, 'utf8');

  // Groupings
  assert.ok(code.includes('title="Discovery"'), 'Discovery section present');
  assert.ok(code.includes('title="Messaging & Chat"'), 'Messaging section present');
  assert.ok(code.includes('title="Notifications & Lock Screen"'), 'Notifications section present');

  // Persisted fields
  assert.ok(code.includes('usernameSearchEnabled'), 'usernameSearchEnabled toggle mapped');
  assert.ok(code.includes('readReceiptsEnabled'), 'readReceiptsEnabled toggle mapped');
  assert.ok(code.includes('typingIndicatorEnabled'), 'typingIndicatorEnabled toggle mapped');
  assert.ok(code.includes('notificationContentVisible'), 'notificationContentVisible toggle mapped');
});

test('Chat Room Creation: Neomorphic controls and preset limits', () => {
  const connectPath = path.resolve(process.cwd(), 'apps/web/app/connect/page.tsx');
  const code = fs.readFileSync(connectPath, 'utf8');

  // Presets and inputs
  assert.ok(code.includes('ROOM_CAPACITY_PRESETS'), 'Room capacity presets array present');
  assert.ok(code.includes('customMaxMembersInput'), 'Custom capacity limit input supported up to 2000');
  assert.ok(code.includes('roomJoinPolicy'), 'Room join policy state managed');
  assert.ok(code.includes('APPROVAL_REQUIRED'), 'APPROVAL_REQUIRED policy supported');
  assert.ok(code.includes('OPEN'), 'OPEN policy supported');
  assert.ok(code.includes('Cancel'), 'Cancel button provided on room creation form');
});

test('Google Login: Username onboarding flow and fallback generation', () => {
  const loginPath = path.resolve(process.cwd(), 'apps/web/app/login/page.tsx');
  const loginCode = fs.readFileSync(loginPath, 'utf8');
  const authServicePath = path.resolve(process.cwd(), 'apps/backend/src/auth/auth.service.ts');
  const authServiceCode = fs.readFileSync(authServicePath, 'utf8');

  // Login page onboarding modal
  assert.ok(loginCode.includes('googleOnboardingUser'), 'Username onboarding modal state managed');
  assert.ok(loginCode.includes('Choose your username'), 'Onboarding prompt text present');
  assert.ok(loginCode.includes('/api/auth/username-availability'), 'Availability checking endpoint called');
  assert.ok(loginCode.includes('Keep @'), 'Option to keep auto-generated fallback username');

  // Backend fallback username generator
  assert.ok(authServiceCode.includes('cleanPrefix'), 'Cleans prefix of email without domain');
  assert.ok(authServiceCode.includes('autoGeneratedUsername'), 'Returns autoGeneratedUsername flag');
});

test('ConversationSidebar: Touch-and-hold action sheet, zero prompt(), hide/block/burn modal flows', () => {
  const sidebarPath = path.resolve(process.cwd(), 'apps/web/components/chat/ConversationSidebar.tsx');
  const code = fs.readFileSync(sidebarPath, 'utf8');

  // Verify zero browser-native prompt() or confirm()
  assert.ok(!code.includes('window.prompt'), 'Zero window.prompt calls');
  assert.ok(!code.includes('prompt('), 'Zero prompt() calls');
  assert.ok(!code.includes('window.confirm'), 'Zero window.confirm calls');

  // Touch and hold (~500ms) and contextmenu trigger
  assert.ok(code.includes('onTouchStart'), 'onTouchStart listener attached');
  assert.ok(code.includes('onTouchMove'), 'onTouchMove listener attached');
  assert.ok(code.includes('onTouchEnd'), 'onTouchEnd listener attached');
  assert.ok(code.includes('onContextMenu'), 'onContextMenu listener attached');
  assert.ok(code.includes('500'), '500ms long press threshold defined');

  // Action sheet & modals present
  assert.ok(code.includes('Open Conversation'), 'Open conversation action present');
  assert.ok(code.includes('Hide Conversation'), 'Hide conversation action present');
  assert.ok(code.includes('Block Contact'), 'Block contact action present');
  assert.ok(code.includes('Burn Conversation'), 'Burn conversation action present');
  assert.ok(code.includes('Confirm with Account Password'), 'Password re-auth required for burning');
});

test('Connect Page: Custom wheel duration picker integration (Hours 0-2160, Minutes 0-59, Seconds 0-59)', () => {
  const pickerPath = path.resolve(process.cwd(), 'apps/web/components/pairing/CustomDurationPicker.tsx');
  const pickerCode = fs.readFileSync(pickerPath, 'utf8');
  const connectPath = path.resolve(process.cwd(), 'apps/web/app/connect/page.tsx');
  const connectCode = fs.readFileSync(connectPath, 'utf8');

  // Picker wheel configuration
  assert.ok(pickerCode.includes('2160'), 'Supports up to 2160 hours (90 days)');
  assert.ok(pickerCode.includes('CustomDurationPicker'), 'CustomDurationPicker component exported');
  assert.ok(pickerCode.includes('snap-y'), 'Scroll snap styling present');

  // Integrated into Connect page
  assert.ok(connectCode.includes('<CustomDurationPicker'), 'CustomDurationPicker rendered on connect page');
  assert.ok(connectCode.includes('tempDuration'), 'Temporary duration seconds managed and passed');
});

test('Settings Page: Centered logout button layout and 90-day username cooldown text', () => {
  const settingsPath = path.resolve(process.cwd(), 'apps/web/app/settings/page.tsx');
  const code = fs.readFileSync(settingsPath, 'utf8');

  // Centered inline flex row on logout
  assert.ok(code.includes('flex items-center justify-center gap-2'), 'Logout button has centered flex row with gap');

  // 90-day cooldown explanation text
  assert.ok(code.includes('90-day cooldown'), 'Mentions 90-day cooldown period');
  assert.ok(code.includes('previous username is held'), 'Explains previous username is held to prevent impersonation');
});
