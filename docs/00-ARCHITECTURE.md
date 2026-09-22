# Architecture

## 1. System context

```
                       ┌───────────────────────┐
                       │   Push Notification    │
                       │   Service (FCM, later) │
                       └───────────▲───────────┘
                                   │ "new message" (no content)
┌───────────────┐   TLS/WSS   ┌────┴─────────────┐   TLS    ┌──────────────────┐
│  Web Client    │◄──────────►│                  │◄────────►│  Google Drive     │
│ (Next.js/TS)   │             │  Backend API      │          │  (service account, │
└───────────────┘             │  (NestJS/TS)      │          │  Shared Drive,     │
┌───────────────┐   TLS/WSS   │  + WebSocket       │          │  encrypted blobs   │
│ Android Client │◄──────────►│  gateway          │          │  only)             │
│ (Kotlin,       │             │                  │          └──────────────────┘
│  future phase) │             └────────┬─────────┘
└───────────────┘                       │
                                ┌────────▼─────────┐
                                │   PostgreSQL      │
                                │ (ciphertext +     │
                                │  metadata only)   │
                                └──────────────────┘
```

The backend is a relay and a coordinator. It authenticates devices, brokers the pairing handshake, queues and delivers ciphertext, stores encrypted file blobs' *references* (not the blobs' plaintext), and enforces access control. It is designed so that a full compromise of the database and Drive storage together still does not yield message or file plaintext — see `01-THREAT-MODEL.md`.

## 2. Tech stack decisions

You gave a reasonable starting point and explicitly asked me to evaluate rather than default to it. Here's the evaluation:

| Layer | Choice | Why | Alternatives considered |
|---|---|---|---|
| Frontend | **Next.js (App Router) + React + TypeScript** | SSR for the (minimal) public shell, good file-based routing for the 3-screen nav you want, huge ecosystem for the Android-later parity concerns (shared TS types for the wire protocol). | Plain Vite+React (simpler, but you lose SSR/routing conventions for little benefit at this scope) |
| Styling | **Tailwind (utility/layout only) + hand-written CSS variables for neomorphic shadows & Liquid Glass** | Tailwind can't natively express the dual-shadow neomorphic technique or tuned `backdrop-filter` recipes — those need real CSS. Utility classes are fine for spacing/layout. | Pure CSS Modules (viable, slightly more boilerplate); styled-components (extra runtime cost for no real benefit here) |
| Animation | **Framer Motion**, used sparingly | You explicitly want subtle motion, not decoration. Framer Motion's layout animations suit soft press/release transitions on neomorphic elements. | CSS transitions only (fine for v1, revisit if interactions need orchestration) |
| Backend | **Node.js + TypeScript + NestJS** | Confirmed. NestJS's module/guard/pipe structure maps directly onto the security requirements: `AuthGuard` for authentication, `ThrottlerGuard` for rate limiting, `class-validator` DTOs for input validation, interceptors for consistent error shapes (important for the hidden-chat "don't leak which failure occurred" requirement). | Fastify/Express directly (less structure, more discipline required to not skip a guard somewhere) |
| Realtime | **Socket.IO** over WebSockets | Confirmed, with a specific reason: Socket.IO gives transport-level reconnection and ack callbacks for free, which we still layer application-level idempotency and an offline queue on top of (Socket.IO reconnecting ≠ guaranteeing no message was missed — see `messages` design). Raw `ws` would mean writing that reconnection logic by hand for no real gain. | Raw `ws` (more control, more to get wrong) |
| Database | **PostgreSQL** | Confirmed — relational fit for users/devices/pairing/conversations/messages, strong constraint support (needed for e.g. "a pairing code can only ever be consumed once" at the DB level, not just app level), mature backup/retention tooling. | — |
| ORM | **Prisma** | Type-safe query results flow straight into TypeScript without hand-written mapping, and its migration files are plain SQL-backed and reviewable — important when the schema encodes security invariants (e.g., a partial unique index enforcing single-use pairing codes). | TypeORM (more "native" to Nest, but Prisma's migration/type story is stronger for a schema this security-sensitive) |
| Cryptography | **libsodium** (`libsodium-wrappers` in the browser via WASM; a libsodium binding in Kotlin later) | This is the one I want to flag explicitly. See below. | Web Crypto API alone |
| Object storage | **Google Drive API**, backend-mediated only | Per your explicit requirement. See the trade-offs called out in the threat model — it's workable, but it's not what I'd pick if storage vendor were an open question (see below). | S3-compatible storage (would be my default choice absent the explicit requirement) |
| Android | **Native Kotlin + Jetpack Compose** | Reasoning below. | React Native / Flutter |

### Why libsodium over Web Crypto API alone

*(Original design rationale — superseded during implementation. See the correction below and `03-ENCRYPTION-PROTOCOL.md`'s own "Correction made during implementation" note: libsodium and the `argon2` package both need a native/WASM binary that couldn't be installed without network access, so the actual implementation uses the standard Web Crypto API and Node's built-in `scrypt` instead. The reasoning below is kept because it's still why cross-platform primitive parity matters for the eventual Android work — just read "the primitives" as "X25519/Ed25519/AES-256-GCM/HKDF via Web Crypto," not literally libsodium.)*

Web Crypto API is a fine primitive source (AES-GCM, ECDSA, HKDF are all there and battle-tested), but it's missing pieces this protocol needs and — more importantly — it has **no equivalent on Android**. If the web client used Web Crypto primitives and the Android client used Android Keystore/Tink primitives, we'd be running two different cryptographic implementations of the same protocol, which is exactly how cross-platform E2EE systems end up with subtle interop bugs or, worse, silent security gaps in one platform's implementation. libsodium has mature, audited bindings on both sides (WASM for the browser, JNI-based bindings for Kotlin), so the same primitives (X25519, Ed25519, XChaCha20-Poly1305, HKDF, Argon2id) run identically on both clients. That parity is worth more here than Web Crypto's marginally stronger browser-side key isolation — and I'm not pretending that trade-off is free; it's documented in `03-ENCRYPTION-PROTOCOL.md` under key storage.

### Why native Kotlin over React Native/Flutter for Android

The Android-specific requirements you listed — Keystore-backed key storage, biometric prompts, `FLAG_SECURE` screenshot blocking, reliable background FCM handling — are all things you'd otherwise be bridging through native modules in a cross-platform framework anyway. For a security-critical app where these aren't nice-to-haves but core requirements, going native removes a layer of indirection between the app and the exact platform guarantee we're relying on. Compose also handles the custom neomorphic shadow/blur rendering well via custom `Modifier`s. This is a Phase 13 decision, documented now so Phase 4's protocol design doesn't accidentally paint us into a web-only corner.

### Google Drive as object storage — a flag, not a blocker

You explicitly required this, so it's in the design. Two things I want on record: (1) Drive is not purpose-built for "many small opaque blobs accessed by API," the way S3/R2/GCS are — expect to think about API quota and per-file overhead once usage grows, not just at launch. (2) It must be a **GCP service account** writing to a **Shared Drive it owns**, never a personal Google account's "My Drive," and never with link-sharing turned on for any file. The backend is the only thing that ever talks to Drive; clients only ever get short-lived, backend-issued download tokens. Full detail in `03-ENCRYPTION-PROTOCOL.md` §7 and `01-THREAT-MODEL.md`.

## 3. Core data flows (high level — full detail in the encryption doc)

**Auth**: device generates its long-term keypair locally → registers account (password, `scrypt`-hashed server-side — see `03-ENCRYPTION-PROTOCOL.md`'s correction note; the original plan here was Argon2id) → receives short-lived access token (15 min) + rotating refresh token (30 days, stored hashed, revocable) → uploads its public identity key, signed pre-key, and a batch of one-time pre-keys to the server.

**Pairing**: User A requests a 6-digit code (server generates via CSPRNG, stores an HMAC of it, not the code itself) → shares it with User B out-of-band (that's on the users — the app never transmits the code between them) → User B redeems it → server validates (rate-limited), invalidates the code, creates the conversation, and hands User B a *fresh* copy of User A's current pre-key bundle → both devices independently derive the same initial shared secret via X3DH, without ever transmitting a private key.

**Messaging (online)**: compose → encrypt locally with the current ratchet message key → send ciphertext + server-assigned sequence number over the authenticated WebSocket → server persists ciphertext + relays to recipient if connected → recipient decrypts locally → delivery/read receipts flow back as small, content-free control messages.

**Messaging (offline)**: same encryption step → server persists ciphertext (recipient not connected) → on reconnect, client requests everything after its last known sequence number → server delivers in order → client acks → server marks delivered.

**Media**: file is encrypted locally with a random per-file key → the per-file key is itself encrypted with the current message key (so it travels *inside* the encrypted message, never in the clear) → only the ciphertext blob goes to Drive via the backend → recipient's backend call returns a short-lived download token → recipient downloads ciphertext, decrypts the file key from the message, decrypts the file.

## 4. What "done" means for Phase 0

This document plus `01`–`05` and the design preview. No application code, no repository scaffold yet — that's Phase 1, per your own phase plan, and I'm holding to it.
