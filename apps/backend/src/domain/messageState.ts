/**
 * Message ordering, idempotency, offline-sync, and disappearing-message
 * timing. Pure logic — the NestJS message service calls these functions
 * but the rules themselves don't know about Prisma or HTTP.
 */

export interface DisappearingConfig {
  timerSeconds: number | null; // null/0 = off
  trigger: 'sent' | 'delivered' | 'read';
  readReceiptsEnabled: boolean;
}

/**
 * If read receipts are off, "read" can never be observed for this
 * conversation, so a timer anchored to "read" would silently never fire.
 * Falls back to "delivered" in that case — see docs/02-DATABASE-SCHEMA.md.
 */
export function resolveDisappearTrigger(config: DisappearingConfig): 'sent' | 'delivered' | 'read' {
  if (config.trigger === 'read' && !config.readReceiptsEnabled) return 'delivered';
  return config.trigger;
}

export function computeDisappearAt(
  config: DisappearingConfig,
  timestamps: { sentAt: Date; deliveredAt?: Date | null; readAt?: Date | null },
): Date | null {
  if (!config.timerSeconds || config.timerSeconds <= 0) return null;
  const trigger = resolveDisappearTrigger(config);
  const anchor =
    trigger === 'sent' ? timestamps.sentAt : trigger === 'delivered' ? timestamps.deliveredAt : timestamps.readAt;
  if (!anchor) return null; // hasn't happened yet — the caller recomputes this once delivered/read actually occurs
  return new Date(anchor.getTime() + config.timerSeconds * 1000);
}

export const DISAPPEARING_OPTIONS: readonly { label: string; seconds: number | null }[] = [
  { label: 'Off', seconds: null },
  { label: '10 seconds', seconds: 10 },
  { label: '30 seconds', seconds: 30 },
  { label: '1 minute', seconds: 60 },
  { label: '5 minutes', seconds: 5 * 60 },
  { label: '1 hour', seconds: 60 * 60 },
  { label: '1 day', seconds: 24 * 60 * 60 },
  { label: '7 days', seconds: 7 * 24 * 60 * 60 },
];

// ---------------------------------------------------------------------------
// Idempotency & ordering
// ---------------------------------------------------------------------------

export interface PendingSend {
  clientMessageId: string;
  conversationId: string;
}

/** A retried send (e.g. after a dropped ack) must not create a second message — matches the @@unique([conversationId, clientMessageId]) constraint in the Prisma schema, checked here first so the caller can return the existing message instead of hitting a DB constraint error. */
export function isDuplicateSend(clientMessageId: string, conversationId: string, existing: PendingSend[]): boolean {
  return existing.some((m) => m.clientMessageId === clientMessageId && m.conversationId === conversationId);
}

/** The next server-assigned sequence number for a conversation. Ordering is always based on this, never on client timestamps, which can skew. */
export function nextSequenceNumber(currentMax: bigint | number): bigint {
  return BigInt(currentMax) + 1n;
}

/**
 * sequenceNumber and syncVersion are drawn from the same per-conversation
 * counter (a new message sets both equal; an edit bumps only syncVersion —
 * see MessagesService.editMessage), so the counter's current position is
 * whichever of the two aggregate maxes is higher, not sequenceNumber alone.
 * Feed the result into nextSequenceNumber above for the next value.
 */
export function higherCounterValue(maxSequenceNumber: bigint | number | null, maxSyncVersion: bigint | number | null): bigint {
  const a = maxSequenceNumber === null ? 0n : BigInt(maxSequenceNumber);
  const b = maxSyncVersion === null ? 0n : BigInt(maxSyncVersion);
  return a > b ? a : b;
}

/**
 * Given the highest sequence number a client has already synced, returns
 * exactly the messages it's missing, in order — the general shape of the
 * offline-resync mechanism.
 *
 * Currently unused in the real application: MessagesService.sync() gets
 * the same result more efficiently with a direct
 * `WHERE syncVersion > after ORDER BY syncVersion ASC` database query
 * rather than fetching every message and filtering/sorting them in
 * application code the way this function does. Kept — and still
 * unit-tested — as a plain specification of the filter's semantics,
 * independent of how any particular caller chooses to fetch the
 * candidate set.
 */
export function computeSyncGap<T extends { sequenceNumber: bigint | number }>(
  clientLastSeen: bigint | number,
  serverMessages: T[],
): T[] {
  const lastSeen = BigInt(clientLastSeen);
  return serverMessages
    .filter((m) => BigInt(m.sequenceNumber) > lastSeen)
    .sort((a, b) => (BigInt(a.sequenceNumber) < BigInt(b.sequenceNumber) ? -1 : 1));
}
