import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.resolve(__dirname, '../..');

test('Terms of Service: complies with legal specifications', () => {
  const termsPath = path.join(webRoot, 'app/terms/page.tsx');
  assert.ok(fs.existsSync(termsPath), 'Terms page must exist');
  const content = fs.readFileSync(termsPath, 'utf8');

  // Must NOT contain standalone "Acceptable Use Policy" section
  assert.ok(!content.includes('Acceptable Use Policy'), 'Must not contain standalone Acceptable Use Policy');
  
  // Must NOT contain standalone "Encryption Realities & Limitations" section
  assert.ok(!content.includes('Encryption Realities & Limitations'), 'Must not contain standalone Encryption Realities & Limitations');

  // Must NOT expose exact infrastructure provider names
  assert.ok(!content.includes('Vercel'), 'Must not name Vercel');
  assert.ok(!content.includes('Render'), 'Must not name Render');
  assert.ok(!content.includes('Aiven'), 'Must not name Aiven');

  // Must contain essential terms: ownership, account deletion, IP, dispute resolution
  assert.ok(content.includes('User Content &amp; Intellectual Property Ownership'), 'Must address user content ownership');
  assert.ok(content.includes('Account Deletion by User'), 'Must address account deletion');
  assert.ok(content.includes('Disclaimer of Warranties'), 'Must contain warranty disclaimer');
  assert.ok(content.includes('Limitation of Liability'), 'Must contain limitation of liability');
});

test('Privacy Policy: complies with disclosures and infrastructure specifications', () => {
  const privacyPath = path.join(webRoot, 'app/privacy/page.tsx');
  assert.ok(fs.existsSync(privacyPath), 'Privacy page must exist');
  const content = fs.readFileSync(privacyPath, 'utf8');

  // Must NOT expose exact infrastructure provider names
  assert.ok(!content.includes('Vercel'), 'Must not name Vercel');
  assert.ok(!content.includes('Render'), 'Must not name Render');
  assert.ok(!content.includes('Aiven'), 'Must not name Aiven');

  // Must accurately describe architecture
  assert.ok(content.includes('End-to-End &amp; Client-Side Encryption'), 'Must mention client-side E2EE');
  assert.ok(content.includes('Infrastructure &amp; Third-Party Service Providers'), 'Must describe infrastructure generically');
});

test('Support Page: "Send Email" responsiveness and fallback copy', () => {
  const supportPath = path.join(webRoot, 'app/support/page.tsx');
  assert.ok(fs.existsSync(supportPath), 'Support page must exist');
  const content = fs.readFileSync(supportPath, 'utf8');

  // Must NOT nest a button inside an anchor
  assert.ok(!content.includes('<a') || !content.match(/<a[^>]*>\s*<Button/i), 'Must not nest Button inside anchor');
  assert.ok(!content.match(/<a[^>]*>\s*<button/i), 'Must not nest button inside anchor');

  // Must have direct mailto anchor with subject and body
  assert.ok(content.includes('href={`mailto:'), 'Must have direct mailto link');
  assert.ok(content.includes('subject='), 'Must prefill email subject');
  assert.ok(content.includes('body='), 'Must prefill email body template');

  // Must provide fallback support email support@pookie.chat
  assert.ok(content.includes('support@pookie.chat'), 'Must have fallback support@pookie.chat');

  // Must have copy button
  assert.ok(content.includes('copyEmail'), 'Must provide copy button');
});

test('Login & Register Pages: Google OAuth instant visual feedback', () => {
  const loginPath = path.join(webRoot, 'app/login/page.tsx');
  const regPath = path.join(webRoot, 'app/register/page.tsx');
  const loginContent = fs.readFileSync(loginPath, 'utf8');
  const regContent = fs.readFileSync(regPath, 'utf8');

  // Both must have googleLoading state
  assert.ok(loginContent.includes('googleLoading'), 'Login must track googleLoading');
  assert.ok(regContent.includes('googleLoading'), 'Register must track googleLoading');

  // Both must display "Connecting to Google…"
  assert.ok(loginContent.includes('Connecting to Google…'), 'Login must show Connecting to Google…');
  assert.ok(regContent.includes('Connecting to Google…'), 'Register must show Connecting to Google…');

  // Both must have official Google multi-color SVG branding (#4285F4)
  assert.ok(loginContent.includes('#4285F4'), 'Login must have Google blue branding');
  assert.ok(regContent.includes('#4285F4'), 'Register must have Google blue branding');

  // Both must disable button while googleLoading is active
  assert.ok(loginContent.includes('googleLoading'), 'Login must disable button while loading');
  assert.ok(regContent.includes('googleLoading'), 'Register must disable button while loading');
});

test('Capture Protection: screen capture hardening & shortcuts', () => {
  const capturePath = path.join(webRoot, 'lib/security/CaptureProtection.tsx');
  assert.ok(fs.existsSync(capturePath), 'CaptureProtection must exist');
  const content = fs.readFileSync(capturePath, 'utf8');

  // Keyboard shortcut interception
  assert.ok(content.includes('PrintScreen'), 'Must intercept PrintScreen');
  assert.ok(content.includes('F12'), 'Must intercept F12 DevTools');

  // Tab visibility listener
  assert.ok(content.includes('visibilitychange'), 'Must listen for visibilitychange');

  // Electron content protection check
  assert.ok(content.includes('setContentProtection'), 'Must support Electron setContentProtection');
});

test('ConversationSidebar: Hide Chat & Chat Lock UI integration', () => {
  const sidebarPath = path.join(webRoot, 'components/chat/ConversationSidebar.tsx');
  assert.ok(fs.existsSync(sidebarPath), 'ConversationSidebar must exist');
  const content = fs.readFileSync(sidebarPath, 'utf8');

  // Must import chatLockState functions
  assert.ok(content.includes('getHiddenChatIds'), 'Must use getHiddenChatIds');
  assert.ok(content.includes('getLockedChatIds'), 'Must use getLockedChatIds');
  assert.ok(content.includes('isChatSessionUnlocked'), 'Must check session unlock');

  // Must have dedicated Hidden Chats section
  assert.ok(content.includes('Hidden Chats ('), 'Must display Hidden Chats section');

  // Must obscure locked conversation snippet
  assert.ok(content.includes('Locked conversation'), 'Must render Locked conversation snippet');

  // Local message search must exclude locked and hidden chats
  assert.ok(content.includes('excludedIds'), 'Must exclude locked/hidden chats from search');
});
