/**
 * Session-epoch lifecycle rules — pure logic, no framework/DB dependency,
 * following the same separation as messageState.ts and pairingCode.ts.
 *
 * THE PROBLEM THIS SOLVES: a conversation's cryptographic session is not
 * the same thing as its database row. Burn deletes messages and marks
 * the row DELETED, but re-pairing after a burn reuses the *same*
 * conversationId (see docs/02-DATABASE-SCHEMA.md — "one conversation,
 * ever, per pair"). That means conversationId alone cannot tell a client
 * "this is the session you should be using": a device that was offline
 * for an entire burn+re-pair cycle would otherwise keep using
 * cryptographic material derived from a handshake that no longer has
 * anything on the other end, with no way to notice — it would just fail
 * to decrypt forever, or worse, successfully send ciphertext under a
 * dead session into a conversation the other party has already moved on
 * from.
 *
 * THE FIX: sessionEpoch is a small integer, stored on Conversation,
 * that starts at 1 and increments by exactly 1 every time a pairing
 * code is successfully redeemed for that conversationId — i.e. every
 * time a brand-new X3DH handshake begins (see PairingService.redeem).
 * It is deliberately a monotonic counter, not a timestamp: "is this the
 * current session" becomes a simple equality check, immune to clock
 * skew, and impossible to satisfy by replaying an old value forward.
 *
 * This is a session-*lifecycle* mechanism, not a cryptographic one — it
 * never enters key derivation or the AAD. The X3DH handshake already
 * guarantees a fresh, independent root key on every redemption (via a
 * fresh ephemeral key), so two different epochs can never collide at
 * the crypto layer. What epoch adds is purely the bookkeeping neither
 * the conversationId nor the crypto engine can provide on its own: a
 * cheap, unambiguous way for a client to tell "am I still on the
 * session that's actually current for this conversation?"
 */

/**
 * The next epoch value after a successful pairing-code redemption. Named
 * rather than inlined as `+ 1` so every caller agrees on what "advances
 * the epoch" means.
 *
 * Currently unused in the real application: PairingService.redeem() bumps
 * the epoch via Prisma's atomic `{ increment: 1 }` directly against the
 * database instead of a read-then-write using this function, specifically
 * to avoid the race a read-then-write would reintroduce (two concurrent
 * redemptions for the same pair could otherwise clobber each other's
 * bump). Kept — and still unit-tested — as the smallest possible
 * specification of what "advance the epoch" means, for anything that
 * ever does need to compute it outside a database increment (e.g. a
 * future admin tool, or a test asserting the semantics rather than
 * exercising Prisma).
 */
export function nextEpoch(currentEpoch: number): number {
  return currentEpoch + 1;
}

/**
 * True if a caller who believes they're acting in `claimedEpoch` is
 * actually out of date relative to the conversation's authoritative
 * `currentEpoch`. Used to reject:
 *  - a handshake being stored against a since-superseded pairing
 *    (HandshakeService.store),
 *  - a fetch of a handshake that was superseded before its intended
 *    recipient ever completed it (HandshakeService.fetch),
 *  - a message send carrying a ratchet session derived from an old
 *    handshake (MessagesService.send).
 *
 * `claimedEpoch === undefined` (the caller didn't send one) is considered
 * stale: sessionEpoch is mandatory for all legitimate V1 clients.
 */
export function isStaleEpoch(claimedEpoch: number | undefined, currentEpoch: number): boolean {
  if (claimedEpoch === undefined) return true;
  return claimedEpoch !== currentEpoch;
}

/**
 * Only an ACTIVE conversation can accept new handshake material or
 * messages — named once so every call site (handshake store/fetch,
 * message send, the conversation-status check) applies the identical
 * rule rather than each re-deriving it slightly differently.
 */
export function isUsableForHandshake(status: string): boolean {
  return status === 'ACTIVE';
}
