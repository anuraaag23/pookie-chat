/**
 * Pure session-freshness logic — deliberately zero imports (not even
 * localDb), so it can be unit tested directly under plain Node (see
 * __tests__/sessionFreshness.node.test.mts) without pulling in anything
 * that touches IndexedDB, mirroring how apps/backend/src/domain/*.ts is
 * kept free of Prisma/NestJS so it's independently testable. sessionStore.ts
 * re-exports this for convenience; it lives in its own file rather than
 * inline there because sessionStore.ts's own import of localDb.ts (an
 * ordinary, idiomatic extensionless TS import — not something worth
 * changing just to appease a test runner) makes that file unimportable
 * under Node's native module resolution outside a bundler.
 *
 * See apps/backend/src/domain/sessionEpoch.ts for the server-side half of
 * this contract (Conversation.sessionEpoch's meaning and lifecycle). This
 * file is the client-side comparison: given what the server just
 * reported, is the ratchet session already sitting in IndexedDB still the
 * one to trust?
 */

export interface SessionFreshnessCheck {
  /** The epoch the locally cached session was established under (StoredSession.epoch). */
  epoch: number;
}

export interface ConversationServerStatus {
  status: string;
  sessionEpoch: number;
}

/**
 * A cached session is trustworthy only if the conversation is currently
 * ACTIVE *and* the epoch it was established under is still the
 * conversation's current one. Either condition failing means: don't
 * decrypt or send with this session — treat it the same as having no
 * session at all, and go through the same "look for a pending handshake,
 * else re-pair" recovery path a first-time open would (see
 * app/chat/[conversationId]/page.tsx's ensureFreshSession).
 */
export function isSessionStale(session: SessionFreshnessCheck, server: ConversationServerStatus): boolean {
  return server.status !== 'ACTIVE' || session.epoch !== server.sessionEpoch;
}
