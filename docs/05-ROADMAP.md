# Roadmap

## Status legend

Introduced this pass, applied below and worth using consistently going
forward — the distinction that matters most in this project's actual
situation (network access has never been available in any sandbox, so
nothing has ever executed inside the real NestJS/Next.js/Postgres
stack):

🟢 Implemented + runtime verified · 🔵 Implemented but runtime unverified (unit/harness-tested only) · 🟠 Partially implemented · 🔴 Broken · ⚪ Not implemented · 🟡 Known limitation (not a bug — an inherent constraint, documented as such)

Nothing in this repository currently qualifies for 🟢. That's an
environment fact, not a quality judgment — see `README.md` and every
session's final report for what actually ran.

## Phase plan

| # | Phase | Status | Note |
|---|---|---|---|
| 0 | Architecture, threat model, DB/encryption/design plan | ✅ Done | This doc set |
| 1 | Repository setup + design system (real code) | ✅ Done | Verified: neomorphism/glass implementation matches `04-DESIGN-SYSTEM.md`, no stray colors outside the customization screen |
| 2 | Auth, users, sessions | 🔵 | Lockout/token/password-hash domain logic covered by passing tests; never run as a live server. This pass: fixed `revokeSession` returning the wrong HTTP status (409, not the 404 its own comment and the harness both already assumed — see "V1 pre-runtime hardening pass" below), and closed a real production-config gap where a boot with un-replaced `.env.example` placeholder secrets, or a too-short secret, previously succeeded silently. |
| 3 | Pairing system | 🔵 | Redeem flow, re-pairing-after-burn, session-epoch bumping, fail-fast-before-mutating-state on a revoked device — and, as of the V1 functional-gap pass, the brute-force lockout (`isLockedOut`/`recordFailedAttempt`) that existed fully unit-tested but was never actually called from `redeem()` at all, now wired up and covered. Never run live. |
| 4 | Encryption protocol | 🔵 | Handshake lifecycle and burn/re-pair session isolation have dedicated regression coverage (`regression-handshake-burn-repair.mjs`, 63 checks) — see `03-ENCRYPTION-PROTOCOL.md` §11a. This pass found and fixed the most severe bug of the whole engagement so far in the per-message ratchet itself: a decrypt failure (corrupted ciphertext, a bit-flip in transit, real tampering) never advanced the receiving chain, only the sync cursor — meaning every message *after* the first failure would also fail (wrong chain-key position), permanently, for the rest of that conversation. Fixed via a new `deriveNextChainKey` export in `engine.ts`; unlike every other frontend fix this engagement, this one is genuinely unit-tested (not just harness-simulated), since the crypto engine has zero DOM/NestJS dependency — 2 new tests, both proven via real mutation testing to actually catch the original bug. Tamper/wrong-AAD rejection itself is unchanged and still fully covered. Still never exercised inside the actual apps. |
| 5 | One-to-one messaging | 🟠 → 🔵 this pass | Several real gaps found and fixed in the V1 functional-gap pass: `clientMessageId` wasn't UUID-shaped (would have failed real `@IsUUID()` validation on every send), the sequence/syncVersion counters had an unhandled race under concurrency, deleted messages never reached an offline recipient's next sync (missing syncVersion bump), and a failed send silently discarded the user's message with no error shown. All fixed, all covered by regression tests (`regression-sync-fix.mjs`, 40 checks). Ordering/idempotency were already solid; correctness under failure and under real DTO validation were not, until this pass. This hardening pass added a bound on the registration/login DTO's `oneTimePrekeysPublic` array (previously unbounded — a malformed/malicious client could submit an arbitrarily large array). |
| 6 | Offline messaging | 🔵 | Sync-gap and ratchet-health-recovery flow covered; deletion/expiry propagation to an offline recipient fixed this pass (see Phase 5's note) |
| 7 | Hidden chat | 🟠 | Timing-safe unlock check is unit-tested; the search-integration path has no automated coverage (needs a real browser) — verify manually once live. See `01-THREAT-MODEL.md` §5 for the PIN's real (no server-side rate limit) security property, now documented identically for app-lock's PIN too, which shares the same mechanism. |
| 8 | Disappearing messages | 🟠 → 🔵 this pass | Was more broken than "untested": `disappearAt` was computed and stored but nothing ever read it back — no cleanup, no delivery-time filter, and the 'delivered' trigger was never computed at all via the sync (offline) delivery path, only the live-push path. All fixed (a lightweight `setInterval` sweep, a defensive sync filter, the missing sync-path computation) and covered (`regression-settings-and-disappearing.mjs`, 18 checks). |
| 9 | Media/documents + encrypted Drive storage | 🟠 | A real gap fixed in the prior pass: deleting or expiring a message never touched its linked attachment (the file stayed downloadable forever — `onDelete: Cascade` doesn't fire on a soft delete). This pass found and fixed the mirror-image gap the schema itself had claimed was already handled: an attachment uploaded but never linked to a message (client crash/close between upload and send) sat forever with no cleanup at all — see "V1 pre-runtime hardening pass" below. Actual Drive upload/download 🟡 — genuinely untestable without real Drive credentials, which don't exist in any sandbox so far. |
| 10 | Security hardening (incl. full Double Ratchet upgrade) | 🟠 | Sequence-number races, epoch-based session isolation, pairing lockout, deletion/disappearing sync propagation, settings enforcement, and (this pass) HTTP-status consistency, orphaned-attachment cleanup, DTO input bounds, and production secret validation. Full Double Ratchet upgrade is still ahead. |
| 11 | Testing | 🔵 | Unit + harness tests run as planned; real-browser (Playwright + Chromium) confirmed runnable in this sandbox too, though not used this pass (no crypto-engine changes to verify that way) |
| 12 | Web production release | ⚪ | |
| 13 | Android application | ⚪ | |
| 14 | Android security hardening | ⚪ | |
| 15 | Final audit | ⚪ | |

## V1 pre-runtime hardening pass (this session)

A full audit pass across backend correctness, session/sync state,
attachment lifecycle, auth/session security, frontend resilience,
privacy, randomness, and configuration — see the session's final report
for the complete 12-section writeup. Summary of what actually changed:

**Backend:**
- `AuthService.revokeSession` returned `ConflictException` (409) despite
  its own comment saying "same 404" and the verification harness already
  modeling 404 — real HTTP-status-code inconsistency, fixed to
  `NotFoundException`.
- **New:** `AttachmentsService.cleanupOrphanedAttachments` — a periodic
  sweep removing attachments that were uploaded but never linked to a
  message (client crash/close between upload and send). The Prisma
  schema comment on `Attachment.messageId` had claimed this cleanup
  existed since early in the project; it never did until this pass. Not
  a confidentiality issue (`download()` already refused to serve an
  unlinked attachment to anyone), but an indefinite, invisible Drive +
  DB storage leak.
- Production config: `env.ts` now rejects `.env.example`'s literal
  placeholder secret values and enforces a minimum secret length (hard
  fail in production, warning in development) — previously any non-empty
  string, including a forgotten placeholder, booted the server silently.
- `RegisterDto`/similar `oneTimePrekeysPublic` array: added
  `@ArrayMaxSize` and per-element `@MaxLength` — previously unbounded.

**Frontend:**
- **New:** `client.ts` exposes `setSessionExpiredHandler`, fired when an
  authenticated call gets a 401 and the follow-up refresh itself fails
  (a genuinely dead session, not a transient blip). `AuthContext`
  registers it to clear local state and redirect to `/login`. Previously
  only the WebSocket `session_revoked` push handled this — a session
  that died while this device was offline (natural 30-day expiry, or a
  revocation missed while disconnected) left every subsequent screen
  silently re-failing its own calls forever, with no path back to login.
- `socket.ts`: the WebSocket `auth` payload was a one-time snapshot of
  the access token, taken once at `connectSocket()`. Socket.io's
  automatic reconnection reuses that same stale object on every retry —
  any drop past the access token's 15-minute lifetime could never
  reconnect again for the rest of the session. Changed to an `auth`
  callback, re-evaluated on every (re)connection attempt.
- Chat conversation page: `handleBlock`, `handleBurn`, `deleteMessage`,
  `setDisappearing`, and `openAttachment` had no error handling at all —
  a failed request (network drop, a race with the other party burning
  the same conversation) failed silently with no feedback, unlike
  `send()`/`sendFile()`, which already handled this correctly. Now all
  give the same kind of user-visible feedback. Also added a genuine
  loading state for the initial bootstrap (previously indistinguishable
  from "no messages in this conversation").
- Chat list page: a failed conversation-list fetch was swallowed and
  rendered identically to a genuine empty inbox. Now shows a distinct
  error state with retry.
- Settings page: `if (!settings) return null` meant a failed initial
  fetch rendered a permanently blank screen with no way to recover short
  of a manual reload. Now shows a loading/error state with retry.
  `updateSettings`'s optimistic update also had no rollback on failure —
  a failed save left the toggle showing a state the server never
  actually persisted, with no indication anything went wrong. Both
  fixed; several other settings-page actions (revoke session(s),
  app-lock PIN) gained the same error handling.

**E2EE ratchet (found in a follow-up round of this same pass — the most
severe bug of the whole engagement):**
- `app/chat/[conversationId]/page.tsx`'s `processIncoming` only advanced
  the receiving ratchet chain (`receivingChainKey`/`recvStep`) inside
  `ratchetDecrypt`'s success path. On any decrypt failure — corrupted
  ciphertext, a bit-flip in transit, genuine tampering, nothing exotic
  required — the chain silently stayed one step behind. Every message
  *after* the first failure would then be decrypted with the wrong
  chain-key position and also fail, cascading into every message after
  that, permanently, for the rest of that conversation — while the sync
  cursor kept advancing regardless, so nothing was ever retried. A
  single bad message (accidental or attacker-injected) permanently
  killed a conversation with no recovery short of burn + re-pair. Fixed
  with a new `deriveNextChainKey` export in `engine.ts` (wraps the
  existing pure HKDF chain-advance step, which never depended on the
  AEAD outcome to begin with — only the old code's plumbing did),
  called from the catch block so the chain advances even when the
  plaintext can't be recovered. Tamper/wrong-AAD rejection is completely
  unchanged — this only stops one bad message from taking the rest of
  the conversation down with it.

**Verification:** all backend changes are code-reviewed and, where the
logic is pure enough to test without NestJS/Prisma/a real database,
directly unit-tested (`env.ts`: 7 new tests) or harness-mirrored and
regression-tested with a genuine mutation proof
(`regression-attachment-orphan-sweep.mjs`: 8 new checks). The ratchet
fix above is also genuinely unit-tested, not just harness-simulated —
the crypto engine has zero DOM/NestJS dependency, so it always has been
directly runnable in this sandbox (`engine.node.test.mjs`: 2 new tests,
both confirmed via real mutation testing — a temporary mutant reverting
the fix — to actually fail without it). All other frontend changes
remain code-reviewed only — no React/Next.js runtime has been available
in any sandbox this entire engagement. Full harness + unit-test suite:
224/224 passing (was 200 before this pass; 215 after the first round,
224 after the ratchet fix above).


## Settings actually enforced (new, this pass)

`readReceiptsEnabled` and `typingIndicatorEnabled` had real, working UI
toggles that did nothing at all server-side (and nothing client-side
either) — turning them off had zero observable effect. Both are now
actually enforced, server-side (the real boundary) and client-side
(avoids the wasted call). `notificationContentVisible` had a working
toggle controlling a notification feature that had never been built at
all (zero `Notification` API calls anywhere) — implemented a scoped
version (notifications for the currently-open conversation, respecting
the toggle; not a background cross-conversation feature, which would
need session material loaded for every conversation at once).
`screenshotProtectionEnabled` was checked and found to be correctly
inert on web already (Android-only by design, never rendered as a web
toggle) — documented more explicitly rather than changed.

## Definition of done, every phase

1. Run whatever tests can actually run in the current environment
2. Review the implementation specifically for the weaknesses that phase introduces
3. Fix what's found
4. Update the relevant doc(s)
5. Report what's complete and what remains — plainly

## Final acceptance checklist (from your brief, tracked here as it's satisfied)

- [ ] Web app works · [ ] Auth works · [ ] Pairing works · [ ] 6-digit codes are secure
- [ ] One-to-one restriction enforced · [ ] E2E encryption works · [ ] Offline messages work · [ ] Reconnection works
- [ ] Read/delivery status works · [ ] Typing indicator works · [ ] Hidden chat works · [ ] App lock works
- [ ] Disappearing messages work · [ ] Burn conversation works · [ ] Media encryption works · [ ] Drive storage works
- [ ] Access control enforced · [ ] Blocking works · [ ] Security tests pass · [ ] Responsive UI
- [ ] Color rules respected · [ ] Neomorphism consistent · [ ] Liquid Glass used appropriately
- [ ] No plaintext secrets stored · [ ] No production credentials committed · [ ] Android architecture documented
- [ ] Final security audit complete

None of these are checked off yet — per the status legend above, "works" means runtime-verified, and nothing has run in the real stack in any sandbox so far.

## Final pre-runtime audit pass (this session)

Requested as a comprehensive final audit before real-browser testing. The
environment claims in that request (real Postgres reachable, npm
install/Prisma generate/migrate already done) did not hold in this
sandbox — verified and reported plainly rather than fabricating
Postgres/NestJS/Next.js output; see the session's final report for the
full account. Everything below is code review plus harness simulation.

Bugs found and fixed: a pairing-code hash-collision crash
(`PairingService.create`, retry-with-fresh-code, same bound as the
sequence-number retry); a refresh-token rotation race
(`AuthService.refresh`, WHERE-guarded on the old hash, same idiom as
pairing redemption's own guard); a redeem() atomicity gap
(`PairingService.redeem`'s core writes now in `$transaction`); a stale
comment in `messages.service.ts` contradicted by the prior session's
ratchet fix. Also discovered `/api/auth/refresh` and `/api/auth/logout`
had never been modeled in the verification harness at all — added both,
plus regression coverage. Checked for and ruled out a Prisma-BigInt /
`JSON.stringify` crash class (native `bigint` from Postgres vs. plain
`number` from the harness's SQLite) — confirmed every response path
already converts explicitly; no bug found there.

Two of the fixes above ($transaction atomicity, the refresh-rotation
guard's actual TOCTOU race) are explicitly code-review-only: this
harness's SQLite runs fully synchronously with no real interleaving, so
no test here can distinguish the fix from its absence for those two
specific mechanisms, and two different attempts at faking such a test
were caught (via mutation testing) and removed rather than kept. Full
suite: 242/242 (67 unit + 175 harness).

## Known scope decisions (not oversights — see `01-THREAT-MODEL.md` for reasoning)

- v1 assumes one primary device per account holding live ratchet state; multi-device fan-out is a documented future enhancement.
- v1 ships a simplified forward-secret ratchet; full Double Ratchet (post-compromise recovery) is Phase 10 work, not claimed done earlier.
- Hidden-chat state lives client-side only — the server never learns it exists.

## Real-environment boot audit (this session)

Requested against a real Windows/Node/PostgreSQL environment the user has
on their own machine — this sandbox has no path to that machine (confirmed:
still fully network/DB-blocked here), so this was code-inspection only,
reasoning about what real `npm install` + `nest start` + `prisma migrate`
would actually do. Two real, previously-undetected, boot-blocking bugs
found and fixed — both invisible to every prior pass because neither the
domain/unit tests nor the verification harness ever exercise real NestJS
dependency injection or real environment-variable loading:

1. **Nothing ever loaded `.env` into `process.env`.** `@nestjs/config` is a
   listed dependency but was never actually imported anywhere — this
   project's own custom `config/env.ts` reads `process.env` directly, and
   nothing populated it. Every real boot would have hit `Error: Missing
   required environment variable: DATABASE_URL` immediately, regardless of
   how correctly a `.env` file was filled in. Fixed: added `dotenv` as a
   real dependency, `import 'dotenv/config'` as the first line of
   `main.ts`. Also found that even fixing this, the *original* file
   location (repo-root `.env.example`, per the old README quickstart)
   would still not have been found — neither `dotenv`'s default (reads
   `process.cwd()`, which is `apps/backend/` whenever this app actually
   runs) nor Prisma CLI's own env-loading (checks `apps/backend/prisma/`,
   then falls back to the same cwd) ever look at a monorepo root. Split
   into `apps/backend/.env.example` and `apps/web/.env.example`, each
   where its respective tool actually looks; updated README's quickstart
   to match; left a redirect note at the old root location.
2. **`MessagesModule` never imported `AttachmentsModule`**, despite
   `MessagesService`'s constructor injecting `AttachmentsService` (used by
   the disappearing-message expiry sweep and message deletion to clean up
   a linked attachment). `NestFactory.create(AppModule)` would have thrown
   `Nest can't resolve dependencies of MessagesService` and refused to
   boot. Checked every other service's constructor against its own
   module's imports systematically after finding this — confirmed this
   was the only instance; every other pairing (including
   `ConversationsService`, which needs the same `AttachmentsService`) was
   already correct.

Both fixes are code-review-only from this session — genuinely unverifiable
without a real `npm install` + real NestJS boot, which this sandbox cannot
do. Full suite re-run after both fixes: still 242/242 (unaffected, as
expected — neither fix touches domain logic).

## Final pre-runtime hardening & completeness pass (this session)

The most severe **functional** bug found in this entire engagement:
**real attachment sending was completely non-functional.**
`MessagesService.send()` only linked an uploaded attachment to its
message when the request included both `attachmentId` and
`encryptedDek` — but the real frontend (`sendFile()`) has never once
sent `encryptedDek` (confirmed via a full grep of `apps/web`; the actual
DEK already travels safely inside the message's own ratchet-encrypted
ciphertext instead). Every attachment sent through the real app silently
failed to link, sat as an "orphan" for an hour, and was deleted —
undownloadable by anyone, including the sender, the entire time. This
was invisible to all 175 prior harness checks because the harness's own
`/api/messages` handler had **zero** attachment-linking logic at all —
every attachment test seeded the database directly via SQL rather than
driving a real send through the endpoint. Fixed on both sides:
`attachmentId` alone is now sufficient (`encryptedDek` remains optional
and is stored as `null` when absent, matching the schema's existing
nullable column); the harness gained real linking logic with the same
ownership/conversation/already-linked checks the backend enforces. New
regression file drives the actual endpoint end to end (11 checks,
mutation-tested against a reverted-fix mutant to confirm it genuinely
catches the bug).

Also found: `DELETE /api/auth/account` (never audited in any prior
session) cascades away every conversation the user is in without ever
telling the other participant — unlike `burn()`, which does. Fixed by
pushing the same `conversation_burned` event for each affected
conversation before deletion. Honestly documented residual gap: an
*offline* peer still has no durable discovery path afterward, since a
hard cascade delete leaves no row for `GET /api/conversations/:id` to
return anything from — closing that fully would need a different data
model for account deletion (e.g. anonymizing rather than deleting the
user row), which is a larger design change than this pass's scope.

A full API-contract inventory (every frontend `api()` call body
cross-checked against its DTO's required fields) confirmed the
attachment bug was isolated, not a pattern — every other endpoint
(register, login, pairing, handshake, message edit, settings) already
matches its DTO exactly. Two long-dead, harmless domain functions
(`nextEpoch`, `computeSyncGap`, both superseded by more efficient
direct-database approaches) were found, traced, confirmed safe, and
left in place with clarifying comments rather than deleted.

Full suite: 253/253 (67 unit + 186 harness, up from 242).

