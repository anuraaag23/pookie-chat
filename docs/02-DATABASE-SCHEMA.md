# Database Schema

PostgreSQL. No plaintext message content, no plaintext passwords, no plaintext hidden-chat credential — anywhere.

A few deliberate deviations from the entity list in the brief, explained inline rather than silently made.

## Entities

### `users`
| Field | Notes |
|---|---|
| `id` | UUID, primary key. This *is* the "User ID" shown in Settings — random, not derived from anything personal. |
| `password_hash` | scrypt, not Argon2id — see docs/03-ENCRYPTION-PROTOCOL.md's note on this. Never the raw password, never a fast hash. |
| `display_name` | Optional, nullable. Visible only to the one paired contact — not a public profile, not searchable. |
| `status` | `active` / `deleted` |
| `failed_login_count`, `locked_until` | Login lockout bookkeeping. |
| `created_at`, `last_login_at` | |

No phone number, no email, no column that could re-identify the person behind the account.

### `devices`
One row per logical client install (a browser profile, an Android install).
| Field | Notes |
|---|---|
| `id`, `user_id` | |
| `device_name` | User-assigned label ("Work laptop"), shown in Settings → Sessions. |
| `identity_signing_public` | Ed25519, long-term. Signs the rotating signed pre-key. |
| `identity_dh_public` | X25519, long-term. Ed25519 can't do the Diffie-Hellman operations X3DH needs, so this is a separate key from the signing one above — see docs/03-ENCRYPTION-PROTOCOL.md §1-2. |
| `signed_prekey_public`, `signed_prekey_signature`, `signed_prekey_created_at` | X25519, rotated periodically; signature proves it belongs to this identity key. |
| `push_token` | Nullable, FCM (Android, future). |
| `platform` | `web` / `android` |
| `last_seen_at`, `revoked_at` | |

### `one_time_prekeys`
| Field | Notes |
|---|---|
| `id`, `device_id` | |
| `public_key` | X25519. |
| `used_at` | Nullable — set the moment it's handed out for a pairing, never reused. A partial unique index / row lock ensures two concurrent pairing attempts can't consume the same key. |

### `auth_sessions`
Login/device sessions — distinct from the *cryptographic* ratchet session, which lives client-side only and the server never sees.
| Field | Notes |
|---|---|
| `id`, `user_id`, `device_id` | |
| `refresh_token_hash` | Hashed, rotated on every use. |
| `created_at`, `expires_at`, `revoked_at` | |
| `ip_hash` | Hashed/truncated, not raw IP, kept only long enough to power new-device alerts. |

### `pairing_codes`
| Field | Notes |
|---|---|
| `id`, `creator_user_id` | |
| `code_hmac` | `HMAC-SHA256(server_pepper, code)` — not a slow password hash, because the lookup needs to be an equality match against a small (1-in-a-million) space; the pepper stops an offline DB-only attacker from just trying all million values against a bare hash, and the real protection is server-side rate limiting (§ below), not hash slowness. |
| `status` | `active` / `used` / `revoked` / `expired` |
| `expires_at` | Nullable = "Forever." |
| `used_by_user_id`, `used_at` | Set once, atomically, on redemption — enforced by a unique constraint so a code can bind to exactly one redeemer even under a race. |
| `failed_attempts`, `locked_until` | Per-code lockout after repeated wrong guesses. |

### `conversations`
Exactly one row per pair, ever (re-pairing after a burn/disconnect reuses or recreates this row per the product decision in Phase 8, not a new parallel one).
| Field | Notes |
|---|---|
| `id`, `user_a_id`, `user_b_id` | Canonically ordered (`user_a_id < user_b_id`) so there's no ambiguity about "who's A." |
| `status` | `active` / `blocked_by_a` / `blocked_by_b` / `deleted` |
| `session_epoch` | Integer, starts at 1, incremented by exactly 1 on every successful pairing-code redemption for this row — including a first-ever pairing, and including a re-pair that isn't preceded by a burn. See "Session epoch" below; full rationale in `apps/backend/src/domain/sessionEpoch.ts`. |
| `disappearing_timer_seconds` | Nullable/0 = off. |
| `disappearing_trigger` | `sent` / `delivered` / `read` — see Phase 8 design note below. |
| `created_at` | |

**Blocking** is a status on this row, not a separate `blocks` table — with exactly one possible counterparty, "blocked" is a property of the relationship, not a many-to-many fact needing its own table.

**Hidden-chat state is deliberately *not* a column here.** The hidden/unhidden flag and the PIN verifier live only in each device's local encrypted storage. This means the server cannot answer "does this user have a hidden chat," which is a stronger privacy property than a boolean column that's merely never displayed — and it's the honest reading of your instruction not to "leak the existence of hidden content." The cost: it doesn't sync across a reinstall or a second device without an explicit, separately-designed opt-in encrypted sync (not in v1).

**Session epoch.** `id` is stable forever for a pair — re-pairing after a burn reuses this exact row rather than creating a new one (see the note above the table). That's the right call for "one conversation, ever, per pair," but it means `conversationId` alone can't tell a client which *cryptographic session* is current: burn deletes the ratchet state's reason for existing, but a device that was offline for the whole burn+re-pair cycle has no way to notice its cached session is from a pairing that no longer exists — the id it's keyed on hasn't changed. `session_epoch` is what answers that. It's a plain integer, not a timestamp, specifically so "is my session current" is an exact equality check rather than something clock skew or ordering ambiguity could confuse. It is bumped on *every* redemption, not just ones following a burn, because every redemption means a brand-new X3DH handshake regardless of why the two people are pairing again. It is never touched by anything else — not by burn, not by block/unblock. Clients carry it alongside their locally stored ratchet session (`StoredSession.epoch` in `apps/web/lib/crypto/sessionStore.ts`) and check it against `GET /api/conversations/:id` before trusting that session; the server independently refuses to store or hand out a handshake, or accept a message send, tagged with a superseded epoch (`apps/backend/src/handshake/handshake.service.ts`, `apps/backend/src/messages/messages.service.ts`). It is deliberately *not* part of the encryption AAD or key derivation — X3DH already guarantees a fresh, independent root key on every handshake via a fresh ephemeral key, so there is no cryptographic collision risk between epochs to defend against; this is purely a session-*lifecycle* bookkeeping mechanism layered on top of an unmodified protocol.

### `pending_handshakes`
One row per conversation (`conversation_id` is the primary key — a conversation has at most one *outstanding* handshake at a time, matching the single-shot X3DH design where only the pairing code's redeemer ever initiates one). Holds the redeemer-generated X3DH handshake message until the creator's device is next online to fetch and complete it.
| Field | Notes |
|---|---|
| `conversation_id` | Primary key. `ON DELETE CASCADE` from `conversations`. |
| `recipient_user_id` | Whichever of the conversation's two users did *not* redeem the pairing code — i.e. whoever still needs to complete their side. |
| `payload` | The `HandshakeMessage` itself — public keys and identifiers only (initiator's identity/ephemeral public keys, which signed prekey and one-time prekey were used). Never private key material, never a derived session key: X3DH's whole point is that both sides *compute* the same session key independently from public values, so nothing here is secret in the way a leaked session key would be. |
| `session_epoch` | The conversation's `session_epoch` at the moment this handshake was stored. Checked again — against the conversation's *current* `session_epoch` — both when storing a new one and when fetching this one, so a handshake left over from a since-superseded pairing can never be stored over, or handed out as if it were, the current one. |
| `created_at` | |

**Deliberately not deleted when fetched.** The device completing a handshake still has to run `completeHandshake()` and persist the resulting session locally *after* fetching this row — if either step fails (the tab closes, an IndexedDB write errors) before the session is actually saved, the very next thing that device does on reopening the conversation is fetch again. Deleting on first read would turn that ordinary transient failure into a permanent lockout, since there'd be nothing left to retry against. This makes the endpoint safely retryable by design, not by accident — see `apps/backend/src/handshake/handshake.service.ts`'s `fetch()`.

**Cleanup happens at two points, for different reasons.** `burn()` explicitly deletes this row as part of its one atomic transaction — not because leaving it would be independently exploitable (the `session_epoch` check above and the conversation's own `status` check in `fetch()` already refuse to serve a handshake for a burned or otherwise non-active conversation, so this is redundant with those on its own), but because burn's whole contract is "erase what's associated with this conversation," and a stale, unfetched handshake for a session that no longer has anything on the other end is squarely that. Separately, storing a *new* handshake (`store()`) always overwrites whatever row was there via `INSERT ... ON CONFLICT` / `upsert` — since this table only ever holds one row per conversation, an old row can never silently accumulate alongside a new one; the newest `store()` call always wins.


| Field | Notes |
|---|---|
| `id`, `conversation_id`, `sender_id` | |
| `sequence_number` | Server-assigned, monotonic per conversation. This governs storage-layer ordering and gap-detection (offline sync). It is **not** what the encryption AAD binds to — see `03-ENCRYPTION-PROTOCOL.md`'s correction on that; the sender doesn't know this value yet at encrypt time. |
| `client_message_id` | Client-generated UUID, used for idempotency if a send is retried after a dropped ack. |
| `ciphertext`, `nonce` | `bytea`. This is the entire message payload — server never parses it. |
| `message_type` | `text` / `image` / `file` / `system` (system = typed enum events like "conversation started," never free text, so nothing sensitive can leak through it) |
| `reply_to_message_id` | Nullable. The *quoted preview* shown in the UI is reconstructed client-side from the referenced message's own decrypted content — never duplicated in plaintext here. |
| `sent_at`, `delivered_at`, `read_at`, `edited_at`, `deleted_at` | |
| `disappear_at` | Computed at send time from the conversation's timer + trigger. |

No separate `message_receipts` table: because a conversation only ever has one possible recipient, `delivered_at`/`read_at` on the message row itself carries everything a per-recipient receipts table would in a group chat. That table only earns its complexity back if group chat ever exists, which it explicitly won't.

### `attachments`
| Field | Notes |
|---|---|
| `id`, `message_id` | |
| `drive_file_id` | Backend-only reference; never sent to the client as a usable Drive URL. |
| `encrypted_dek` | The file's random data-encryption key, itself encrypted to the recipient — travels inside the message ciphertext, not as a separate plaintext column. |
| `mime_type_hint` | Coarse only (`image` / `file`), not the original MIME string, to limit fingerprinting. |
| `original_size`, `encrypted_size` | |
| `expires_at`, `uploaded_at`, `deleted_at` | |

Original filenames are never stored here or used as the Drive filename — a random UUID is. If a display filename matters to the user, it's part of the encrypted payload, decrypted client-side, same as message text.

### `security_events`
| Field | Notes |
|---|---|
| `id`, `user_id`, `event_type` | Enum: `new_device`, `new_pairing`, `pairing_revoked`, `pairing_lockout`, `hidden_chat_lockout`, `password_changed`, `session_revoked`, `suspicious_login` |
| `metadata` | `jsonb` — device name, coarse location if ever added, timestamp. Never message content, by construction (the type system doesn't have a field for it). |
| `created_at` | |

### `user_settings`
One row per user: `read_receipts_enabled`, `typing_indicator_enabled`, `notification_content_visible` (default **false** — notifications say "New message," per §36 of your brief), `accent_color` (nullable = default palette), `app_lock_enabled`, `app_lock_timeout_seconds`, `app_lock_method`, `screenshot_protection_enabled` (Android).

## Retention & deletion

| Data | Default rule |
|---|---|
| Message ciphertext, no disappearing timer set | Kept until both delivered and read are acknowledged, or 30 days undelivered (safety-net purge for abandoned accounts), whichever comes first |
| Message ciphertext, disappearing timer set | Deleted at `disappear_at`, regardless of read state |
| Conversation burn | Immediate, not job-based: messages, attachments (DB rows *and* their Drive-side files — `AttachmentsService.purgeDriveFilesForConversation`), and the pending handshake row (if any) are removed synchronously as part of burning, not left for the routine expiry job below to eventually catch up to. See `ConversationsService.burn` and `02-DATABASE-SCHEMA.md`'s `pending_handshakes` section above for why the handshake cleanup specifically is redundant-by-design rather than the only thing preventing reuse. |
| Disappearing-timer trigger, if the recipient has read receipts off | Falls back to `delivered` as the trigger, since `read` would otherwise never fire — documented so the default isn't silently "never expires" |
| Attachments | Same lifecycle as their parent message when linked to one; Drive-side delete is triggered by the same job that purges the DB row, not a separate manual step. An attachment that never gets linked to a message at all (upload succeeded, then the client crashed or closed before send()) has its own separate periodic sweep — `AttachmentsService.cleanupOrphanedAttachments`, added during the V1 pre-runtime hardening pass after this table's own prior claim that "the same expiry job" already covered this turned out not to be true. One hour unlinked is treated as abandoned. |
| `pairing_codes` | Purged 7 days after `expires_at`/use/revocation — kept briefly for the security-event/audit trail, not indefinitely |
| `security_events` | 90-day rolling retention |
| `auth_sessions` (revoked/expired) | 30 days, then purged |

## Indexes / constraints worth calling out now

- Unique partial index on `pairing_codes(code_hmac) WHERE status = 'active'` — prevents two simultaneously-active codes from colliding.
- Unique constraint on `conversations(user_a_id, user_b_id)` — structurally enforces "one conversation, ever, per pair."
- Index on `messages(conversation_id, sequence_number)` — this is the hot path for both live delivery and offline resync.
