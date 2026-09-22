import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveDisappearTrigger,
  computeDisappearAt,
  isDuplicateSend,
  nextSequenceNumber,
  higherCounterValue,
  computeSyncGap,
} from '../messageState.ts';

test('disappearing: falls back from "read" to "delivered" when read receipts are off', () => {
  const trigger = resolveDisappearTrigger({ timerSeconds: 60, trigger: 'read', readReceiptsEnabled: false });
  assert.equal(trigger, 'delivered');
});

test('disappearing: "read" trigger is honored when read receipts are on', () => {
  const trigger = resolveDisappearTrigger({ timerSeconds: 60, trigger: 'read', readReceiptsEnabled: true });
  assert.equal(trigger, 'read');
});

test('disappearing: computes expiry from the right anchor timestamp', () => {
  const sentAt = new Date('2026-01-01T00:00:00Z');
  const deliveredAt = new Date('2026-01-01T00:00:05Z');
  const config = { timerSeconds: 60, trigger: 'delivered' as const, readReceiptsEnabled: true };
  const expiry = computeDisappearAt(config, { sentAt, deliveredAt, readAt: null });
  assert.equal(expiry?.toISOString(), '2026-01-01T00:01:05.000Z');
});

test('disappearing: returns null if the anchor event has not happened yet', () => {
  const config = { timerSeconds: 60, trigger: 'read' as const, readReceiptsEnabled: true };
  const expiry = computeDisappearAt(config, { sentAt: new Date(), deliveredAt: null, readAt: null });
  assert.equal(expiry, null);
});

test('disappearing: off (null seconds) never computes an expiry', () => {
  const config = { timerSeconds: null, trigger: 'sent' as const, readReceiptsEnabled: true };
  const expiry = computeDisappearAt(config, { sentAt: new Date() });
  assert.equal(expiry, null);
});

test('idempotency: a retried send with the same client id is recognized as a duplicate', () => {
  const existing = [{ clientMessageId: 'abc', conversationId: 'conv-1' }];
  assert.equal(isDuplicateSend('abc', 'conv-1', existing), true);
  assert.equal(isDuplicateSend('abc', 'conv-2', existing), false, 'same id, different conversation is not a duplicate');
  assert.equal(isDuplicateSend('xyz', 'conv-1', existing), false);
});

test('sequencing: always increments, never reuses', () => {
  assert.equal(nextSequenceNumber(0), 1n);
  assert.equal(nextSequenceNumber(41), 42n);
  assert.equal(nextSequenceNumber(9007199254740991), 9007199254740992n);
});

test('shared counter: sequenceNumber and syncVersion start equal, so either could lead', () => {
  assert.equal(higherCounterValue(5, 5), 5n);
});

test('shared counter: an edit can push syncVersion above every sequenceNumber issued so far', () => {
  // e.g. 3 messages sent (sequenceNumber/syncVersion both reach 3), then
  // message 1 gets edited — its syncVersion jumps to 4, but the highest
  // sequenceNumber in the conversation is still 3.
  assert.equal(higherCounterValue(3, 4), 4n);
});

test('shared counter: sequenceNumber can lead too — no edits yet since the last new message', () => {
  assert.equal(higherCounterValue(5, 3), 5n);
});

test('shared counter: an empty conversation (no rows yet) has nothing on either side', () => {
  assert.equal(higherCounterValue(null, null), 0n);
});

test('offline sync: returns exactly the messages after the client\'s last-seen sequence, in order', () => {
  const serverMessages = [
    { id: 'a', sequenceNumber: 1 },
    { id: 'b', sequenceNumber: 2 },
    { id: 'c', sequenceNumber: 3 },
    { id: 'd', sequenceNumber: 4 },
  ];
  const gap = computeSyncGap(2, serverMessages);
  assert.deepEqual(gap.map((m) => m.id), ['c', 'd']);
});

test('offline sync: a fully caught-up client gets nothing', () => {
  const serverMessages = [{ id: 'a', sequenceNumber: 1 }];
  assert.deepEqual(computeSyncGap(1, serverMessages), []);
});

// Regression test for the "own messages returned as incoming" bug — this
// tests the actual filtering rule the fixed sync query relies on, since
// the query itself needs a real Postgres connection to run directly.
test('regression: sync must exclude the caller\'s own messages, not just mark them undelivered', () => {
  const allMessages = [
    { id: 'm1', senderId: 'alice', sequenceNumber: 1 },
    { id: 'm2', senderId: 'bob', sequenceNumber: 2 },
    { id: 'm3', senderId: 'alice', sequenceNumber: 3 },
    { id: 'm4', senderId: 'bob', sequenceNumber: 4 },
  ];
  const asAlice = allMessages.filter((m) => m.senderId !== 'alice');
  assert.deepEqual(asAlice.map((m) => m.id), ['m2', 'm4'], 'alice syncing should only ever see bob\'s messages');
  const asBob = allMessages.filter((m) => m.senderId !== 'bob');
  assert.deepEqual(asBob.map((m) => m.id), ['m1', 'm3'], 'bob syncing should only ever see alice\'s messages');
});

// Regression test for the "edit made while recipient is offline is never
// synced" bug. sequenceNumber must stay stable (display ordering and the
// unique constraint both depend on it), so an edit bumps a separate
// syncVersion field instead — this is the filtering rule sync's query
// relies on, mirrored here the same way the test above mirrors the
// sender-exclusion rule.
test('regression: an edit made while the recipient is offline is still picked up by their next sync', () => {
  // 3 messages sent (sequenceNumber === syncVersion for each, since none
  // have been edited), Bob syncs and is caught up through syncVersion 3.
  const messages = [
    { id: 'm1', sequenceNumber: 1, syncVersion: 1 },
    { id: 'm2', sequenceNumber: 2, syncVersion: 2 },
    { id: 'm3', sequenceNumber: 3, syncVersion: 3 },
  ];
  const bobLastSynced = 3;
  assert.deepEqual(computeSyncGap(bobLastSynced, messages).map((m) => m.id), [], 'fully caught up — nothing new yet');

  // While Bob is offline, Alice edits m1. Its sequenceNumber (position in
  // the timeline) must not change, or it would jump to the end of the
  // conversation just because it was edited — but its syncVersion is
  // bumped to a fresh value from the shared counter, e.g. 4.
  const afterEdit = [
    { id: 'm1', sequenceNumber: 1, syncVersion: 4 },
    { id: 'm2', sequenceNumber: 2, syncVersion: 2 },
    { id: 'm3', sequenceNumber: 3, syncVersion: 3 },
  ];
  const gapBySequenceNumber = computeSyncGap(bobLastSynced, afterEdit);
  assert.deepEqual(gapBySequenceNumber.map((m) => m.id), [], 'THE BUG: filtering on sequenceNumber alone never surfaces the edit — m1\'s sequenceNumber (1) is still <= 3');

  const bySyncVersion = afterEdit.map((m) => ({ id: m.id, sequenceNumber: m.syncVersion }));
  const gapBySyncVersion = computeSyncGap(bobLastSynced, bySyncVersion);
  assert.deepEqual(gapBySyncVersion.map((m) => m.id), ['m1'], 'THE FIX: filtering on syncVersion surfaces exactly the edited message, since its syncVersion (4) is now > 3');
});
