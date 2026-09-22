// Pure-logic test, run directly under Node — same approach as
// engine.node.test.mjs. sessionFreshness.ts has zero imports of its own
// (see its file comment for why), so it needs no module-resolution
// workaround the way importing sessionStore.ts directly would.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isSessionStale } from '../sessionFreshness.ts';

test('isSessionStale: matching epoch on an ACTIVE conversation is trusted', () => {
  assert.equal(isSessionStale({ epoch: 1 }, { status: 'ACTIVE', sessionEpoch: 1 }), false);
});

test('isSessionStale: THE BUG THIS FIXES — a cached session from before a burn+re-pair is stale even though the conversation is ACTIVE again', () => {
  // This is exactly the dangerous case: without an epoch check, "status
  // === ACTIVE" alone (the only thing the old code effectively checked,
  // via the send/sync endpoints not throwing) looks identical whether
  // the session is current or from a dead pairing.
  assert.equal(isSessionStale({ epoch: 1 }, { status: 'ACTIVE', sessionEpoch: 2 }), true);
});

test('isSessionStale: a burned conversation is stale regardless of epoch', () => {
  assert.equal(isSessionStale({ epoch: 1 }, { status: 'DELETED', sessionEpoch: 1 }), true);
});

test('isSessionStale: a blocked conversation is stale too — not just DELETED', () => {
  assert.equal(isSessionStale({ epoch: 1 }, { status: 'BLOCKED_BY_A', sessionEpoch: 1 }), true);
  assert.equal(isSessionStale({ epoch: 1 }, { status: 'BLOCKED_BY_B', sessionEpoch: 1 }), true);
});

test('isSessionStale: an epoch far ahead of what is cached is still correctly flagged (multiple burn+re-pair cycles missed)', () => {
  assert.equal(isSessionStale({ epoch: 1 }, { status: 'ACTIVE', sessionEpoch: 5 }), true);
});
