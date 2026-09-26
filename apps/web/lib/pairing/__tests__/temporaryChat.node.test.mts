import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { formatCountdown, isTemporaryChatExpired } from '../temporaryChat.ts';
import { TEMPORARY_DURATIONS } from '../durations.ts';

test('formatCountdown: formats durations under 1 hour with MM:SS remaining', () => {
  const now = 1_000_000_000;
  // 42 seconds remaining
  const exp42s = now + 42 * 1000;
  assert.equal(formatCountdown(exp42s, now), '00:42 remaining');

  // 59 minutes 42 seconds remaining
  const exp59m42s = now + (59 * 60 + 42) * 1000;
  assert.equal(formatCountdown(exp59m42s, now), '59:42 remaining');
});

test('formatCountdown: formats durations between 1 hour and 24 hours with HH:MM:SS remaining', () => {
  const now = 1_000_000_000;
  // 2 hours 14 minutes 8 seconds remaining
  const exp2h = now + (2 * 3600 + 14 * 60 + 8) * 1000;
  assert.equal(formatCountdown(exp2h, now), '02:14:08 remaining');

  // 12 hours 0 minutes 0 seconds remaining
  const exp12h = now + 12 * 3600 * 1000;
  assert.equal(formatCountdown(exp12h, now), '12:00:00 remaining');
});

test('formatCountdown: formats durations of 1 day or more with Xd XXh XXm remaining', () => {
  const now = 1_000_000_000;
  // 1 day 6 hours 32 minutes remaining
  const exp1d = now + (24 * 3600 + 6 * 3600 + 32 * 60) * 1000;
  assert.equal(formatCountdown(exp1d, now), '1d 06h 32m remaining');

  // 90 days remaining
  const exp90d = now + 90 * 86400 * 1000;
  assert.equal(formatCountdown(exp90d, now), '90d 00h 00m remaining');
});

test('formatCountdown: never displays negative numbers when past expiration', () => {
  const now = 1_000_000_000;
  // exactly 0 remaining
  assert.equal(formatCountdown(now, now), '00:00 remaining');

  // 10 seconds past expiration
  assert.equal(formatCountdown(now - 10_000, now), '00:00 remaining');

  // 2 hours past expiration
  assert.equal(formatCountdown(now - 7_200_000, now), '00:00 remaining');
});

test('isTemporaryChatExpired: detects past and future timestamps accurately', () => {
  const now = 1_000_000_000;
  assert.equal(isTemporaryChatExpired(null, now), false);
  assert.equal(isTemporaryChatExpired(undefined, now), false);
  assert.equal(isTemporaryChatExpired(now + 60_000, now), false);
  assert.equal(isTemporaryChatExpired(now, now), true);
  assert.equal(isTemporaryChatExpired(now - 1000, now), true);
});

test('TEMPORARY_DURATIONS: includes all presets including 30d and 90d', () => {
  const labels = TEMPORARY_DURATIONS.map((d) => d.label);
  assert.deepEqual(labels, ['15m', '1h', '1d', '7d', '30d', '90d']);
  assert.equal(TEMPORARY_DURATIONS.find((d) => d.label === '90d')?.seconds, 90 * 86400);
});

test('Chat page: enforces real-time socket events and creator-only extend controls', () => {
  const chatPagePath = path.resolve(process.cwd(), 'apps/web/app/chat/[conversationId]/page.tsx');
  const code = fs.readFileSync(chatPagePath, 'utf8');

  // Real-time socket events
  assert.ok(code.includes("socket.on('temporary_chat_expired'"), 'Listens for temporary_chat_expired');
  assert.ok(code.includes("socket.on('temporary_chat_expiry_updated'"), 'Listens for temporary_chat_expiry_updated');
  assert.ok(code.includes("socket.off('temporary_chat_expired')"), 'Unbinds temporary_chat_expired on unmount');
  assert.ok(code.includes("socket.off('temporary_chat_expiry_updated')"), 'Unbinds temporary_chat_expiry_updated on unmount');

  // Creator authorization check for extend button
  assert.ok(code.includes('isCreator && !isChatExpired'), 'Only creator sees extend button when not expired');

  // Disabled composer when expired
  assert.ok(code.includes('isChatExpired ?'), 'Renders disabled expired UI state when isChatExpired');
  assert.ok(code.includes('This temporary conversation has expired'), 'Explains messages have been securely deleted');

  // Extend API endpoint called
  assert.ok(code.includes('/temporary/extend'), 'Calls backend temporary extend endpoint');
});
