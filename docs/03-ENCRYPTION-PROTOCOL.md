# Encryption Protocol

Nothing here is invented — this is a design in the style of the publicly documented Signal Protocol (X3DH handshake + a symmetric-key ratchet), built from standard, well-reviewed building blocks. Read `01-THREAT-MODEL.md` §5 alongside this — in particular, the honest caveat that a from-scratch implementation of this design should get a professional cryptographic audit before it protects real sensitive communications at scale.

**Correction made during implementation, not just in review:** this doc originally specified libsodium for all primitives and Argon2id for password/PIN hashing. Neither libsodium nor the `argon2` package can be installed in a sandbox with no network access — both need a native or WASM binary fetched from the registry. Building the actual engine end-to-end surfaced that browsers now support X25519 and Ed25519 natively via the standard Web Crypto API (`crypto.subtle`), so the implementation uses that instead of libsodium — same curves, same protocol shape, no bundled third-party crypto code at all. Password/PIN hashing uses Node's built-in `scrypt` (account passwords, backend) and Web Crypto's `PBKDF2` (the hidden-chat/app-lock local secret, browser-side — scrypt isn't part of the standard Web Crypto API). §0, §1, and §14 below describe what's actually implemented; see `apps/web/lib/crypto/engine.ts` and `apps/backend/src/domain/password.ts` for the code these correspond to.

## 0. Primitives used and why

| Purpose | Primitive | Why this one |
|---|---|---|
| Key exchange | X25519, via native Web Crypto API | Fast, constant-time, the standard ECDH curve for this kind of protocol; using the browser's own implementation means no bundled crypto code to audit ourselves |
| Identity signing | Ed25519, via native Web Crypto API | Signs the signed pre-key so a device can prove "this pre-key really belongs to my identity key" |
| Symmetric authenticated encryption | AES-256-GCM, via native Web Crypto API | 12-byte nonce, not XChaCha20-Poly1305's 24 — but the ratchet (§5) derives a distinct message key per message, so no two messages ever encrypt under the same (key, nonce) pair regardless of nonce size. The 24-byte-nonce margin XChaCha20 would add is real but not load-bearing given that design; AES-GCM is natively available in Web Crypto and XChaCha20-Poly1305 is not |
| Key derivation | HKDF-SHA256 | Standard, used to derive every chain/message key from the shared secret |
| Account password hashing | scrypt (RFC 7914), Node's built-in `crypto.scrypt` | Argon2id needs the `argon2` package's native addon — uninstallable with no network access. scrypt is also memory-hard and OWASP-acceptable, with zero external dependencies |
| Hidden-chat / app-lock local secret hashing | PBKDF2-SHA256, via native Web Crypto API | Runs client-side only, where scrypt isn't part of the standard Web Crypto API; PBKDF2 is. Not used for account passwords, where scrypt is available (server-side, Node) and preferred |

## 1. Key generation

Every **device** (not account — see §8) generates locally, at first launch, and never transmits the private half of:
- One long-term **identity signing key pair** (Ed25519) — signs the signed pre-key
- One long-term **identity DH key pair** (X25519) — a separate key from the one above, since Ed25519 keys can't perform the Diffie-Hellman operations X3DH needs; this is the one actually used in the DH computations in §3-4
- One **signed pre-key pair** (X25519), signed by the identity signing key
- A batch of **one-time pre-key pairs** (X25519) — default pool size 100, client tops itself back up when the server reports fewer than 20 remaining

Only the public halves, plus the signed pre-key's signature, are ever uploaded.

## 2. Public/private keys

- Identity keys (signing + DH, together): long-term, one pair of each per device, prove "this is the same device you paired with" over time (either changing is what should trigger a "this contact's device changed" warning, the equivalent of Signal's safety-number change).
- Signed pre-key: medium-term (rotated weekly), used in the handshake so a session can be established even if the device isn't online at the exact redemption moment.
- One-time pre-keys: single-use, one consumed per new session establishment, giving the handshake forward secrecy even for that very first exchange.

## 3. Key exchange & 4. Session establishment (the pairing handshake)

This is where the 6-digit code and the cryptography meet:

1. User A requests a pairing code. Server creates the `pairing_codes` row bound to A's account (§`02-DATABASE-SCHEMA.md`), returns the 6 digits to A's client only.
2. A shares the digits with B out-of-band (voice, in person, a trusted channel — the app itself never transports the code between the two people).
3. B enters the code. Server validates it (rate-limited — see §"pairing guesser" in the threat model), and if valid:
   - Marks the code used, atomically, bound to B — a code can never be consumed twice.
   - Creates the `conversations` row for A+B.
   - Fetches A's **current** bundle (identity signing key + identity DH key + signed pre-key + signature + one fresh one-time pre-key) and returns it to B's client.
4. B's device runs the X3DH computation: combines B's own identity/ephemeral keys with A's bundle via a sequence of Diffie-Hellman operations, then HKDFs the result into an initial **root key**. B sends back its own public identity keys, its ephemeral public key, and which one-time pre-key ID it consumed.
5. Whenever A's device is next online, it performs the mirror-image DH operations using its own *private* keys (which never left the device) plus B's public keys, arriving independently at the identical root key.

Neither device ever transmits a private key. The shared secret exists because of the math, not because it was sent.

## 5. Message encryption & the ratchet

From the root key, both sides derive independent sending/receiving **chain keys** via HKDF. For every message:

```
message_key   = HMAC(chain_key, "message")
chain_key_next = HMAC(chain_key, "ratchet")     ← one-way; old chain_key is discarded
ciphertext    = AES-256-GCM(message_key, plaintext, aad = conversation_id || step_counter)
```

This gives **forward secrecy at the message level**: if a message key or a chain key at some point in time leaks, it doesn't expose messages encrypted earlier in that chain (the one-way function can't be run backwards). It does not yet give full **post-compromise security** — that requires periodic fresh DH ratchet steps (full Double Ratchet), which is scoped as Phase 10 hardening rather than claimed as done now (see the threat model flag).

The AAD binding (conversation ID + this chain's own step index) stops a ciphertext from being replayed into a different conversation or reordered without detection.

**Correction made during implementation, not just in review:** the original version of this doc bound AAD to the *server-assigned* sequence number. Building the actual send/receive flow end-to-end (see `verification-harness/`) surfaced that this doesn't work — the sender doesn't know that number yet at encrypt time, since the server only assigns it on receipt. AAD is bound to each side's own local ratchet step counter instead (`sendStep` / `recvStep`, incremented once per message sent/decrypted): because messages are always processed in the server's sequence order, the Nth message sent is always the Nth message decrypted, so both sides derive the same value independently, with no extra round trip. This is exactly the kind of bug that only shows up when you run the flow rather than read it — worth stating plainly rather than quietly patching the diagram.

**A second correction, found during the V1 pre-runtime hardening pass:** `recvStep` (and `receivingChainKey` with it) must advance for *every* message position, whether or not that message's plaintext is actually recoverable. `chain_key_next` above is a pure function of `chain_key` alone — it never depended on whether the AEAD step that follows it succeeds. The first implementation of the receiving side didn't reflect that: it only advanced the chain inside the decrypt-succeeded path, so a single corrupted or tampered ciphertext (or an accidental bit-flip in transit — this doesn't require an attacker) left the chain one step behind the sender's for the rest of the conversation. Every message after that point would then be decrypted at the wrong chain-key position, fail too, and so on — one bad message permanently broke the whole conversation going forward, with no recovery short of burn + re-pairing. Fixed by deriving `chain_key_next` unconditionally (a new `deriveNextChainKey` in `engine.ts`) and advancing the receiving side with it regardless of decrypt outcome. This does not weaken the tamper-detection property in Message authentication below — a corrupted or tampered message's plaintext is still never recovered — it only stops that one failure from taking every later message down with it.

## 6. Message authentication

Handled by the AEAD tag itself (Poly1305) — one primitive gives both confidentiality and integrity/authenticity. Because only the two paired devices can ever derive the message key, successful decryption is itself implicit proof the message came from the legitimate chain. Deliberately, this design does **not** aim for strong cryptographic non-repudiation (the ability to later "prove" to a third party exactly what someone said) — that's a conscious property inherited from this style of protocol, not an oversight.

## 7. Media encryption

- Client generates a random per-file key (DEK) and encrypts the file locally.
- The DEK is itself encrypted using the *current message key* — so it travels inside the encrypted message that references the attachment, never as a separate plaintext value anywhere.
- Only the file ciphertext goes to Drive, via the backend, using a service account on a dedicated Shared Drive — never a personal account, never with link-sharing on. Clients never talk to Drive directly and never receive a Drive-native URL; they get a short-lived, backend-issued download token that the backend exchanges for the actual bytes.
- EXIF (including GPS) is stripped client-side, before encryption, by default. Original filenames are discarded; a random UUID is used as the Drive-side filename.

## 8. Device keys

Keys belong to **devices**, not accounts. An account with two devices has two independent identity keys and, in the current (v1) design, only one of them holds the "live" ratchet state per conversation at a time (see the threat-model flag on single-device v1 scope). The `devices` table is deliberately shaped to support real multi-device later without a schema rewrite, even though the ratchet logic doesn't yet fan out across devices.

## 9. Key rotation

- Signed pre-keys: rotated weekly by each device automatically.
- One-time pre-keys: replenished continuously as they're consumed.
- Message/chain keys: effectively rotate on every single message via the ratchet in §5.

## 10. Session revocation

Revoking a device (Settings → Sessions, or automatically after a "device lost" report) does three things server-side: invalidates its refresh tokens, stops handing out its one-time pre-keys, and marks it `revoked` so it no longer appears as a valid target. What it **cannot** do: reach into that device and erase whatever it already decrypted while it was legitimate — revocation is a server-side access control, not a remote wipe. If real remote wipe matters to you, that's an Android-specific MDM-style feature to design separately later, not something an E2EE protocol itself provides.

## 11. Recovery limitations & what happens when a device is lost

There is no key escrow anywhere in this design — not on the server, not recoverable via a password reset. That's deliberate: it's the thing that makes "the database was breached" a non-event for message content. The direct consequence:

- If the lost device was the only one with the live keys for a conversation, that side's history is gone. It cannot be restored from the server.
- Recovery is **re-pairing**, not key restoration. The other party would see the equivalent of Signal's "safety number changed" — their contact's identity keys changed, prompting a fresh trust decision — rather than a silent, invisible swap.
- Practical mitigation available to the user: revoke the lost device immediately (from another device, or via account recovery) so its tokens and pre-key pool stop being usable, even though it can't undo what was already decrypted while legitimate.

### 11a. Burn + re-pairing: telling sessions apart when the conversation id doesn't change

"Burn Conversation" and a subsequent re-pair are a *voluntary* version of the lost-device scenario above — both people still have working devices, but they've deliberately started over. The protocol steps are unchanged: re-pairing runs a brand-new X3DH handshake exactly like a first-ever pairing, which by construction (a fresh ephemeral key every time) derives a root key and chain keys completely independent of whatever came before. There is no cryptographic path from the old session to the new one, and nothing here changes that.

What burn+re-pair introduces is a *lifecycle bookkeeping* problem, not a cryptographic one: `conversationId` is deliberately stable forever for a given pair (`02-DATABASE-SCHEMA.md` — re-pairing reuses the same row rather than creating a new one), so it cannot by itself tell a device "the session you have cached for this id is from a pairing that's since been superseded." A device that was offline for an entire burn+re-pair cycle would otherwise have no way to notice — it would just keep trying to use dead keys, either failing to decrypt forever or, worse, successfully sending ciphertext under the old session into what is now a different conversation as far as the other party's client is concerned.

The fix is `Conversation.sessionEpoch` — a plain, monotonically-increasing integer, never a timestamp, bumped by exactly 1 on every successful pairing-code redemption for a given conversation row (see `apps/backend/src/domain/sessionEpoch.ts` for the full contract). It is not cryptographic material: it never enters key derivation or the AAD, and two sessions from different epochs are already unrelated at the key level regardless of whether anything tracks the epoch at all. Its only job is to let both sides — client and server — agree on which handshake is the current one:

- The client stores the epoch alongside its ratchet state (`StoredSession.epoch`) and checks it against the conversation's current epoch (`GET /api/conversations/:id`) before trusting a cached session, at bootstrap and on every reconnect.
- The server refuses to store a handshake, hand out a handshake, or accept a message send, tagged with an epoch that no longer matches the conversation's current one (`handshake.service.ts`, `messages.service.ts`) — this is the backstop that holds even if a client never notices its own session is stale.

This is why re-pairing after a burn is safe even though the two conversations share a database row: the row is the same, but nothing about the session is, and everything that touches the session checks that before trusting it.

## 12. What the server can see

Account existence · device public keys (public by design, not sensitive) · pairing metadata (who paired with whom, when) · message existence, timing, size, and sequence number · delivery/read timestamps (needed to relay the receipt signal) · attachment size/timing/reference · security-event metadata.

## 13. What the server cannot see

Message plaintext · file plaintext · any private key, ever · the hidden-chat PIN or even whether a hidden chat exists (kept client-side only, §`02-DATABASE-SCHEMA.md`).

## 14. Key storage per platform

**Browser (web).** Now that key generation and DH/signing run through the native Web Crypto API rather than a bundled libsodium WASM build, the actual elliptic-curve math executes inside the browser's own vetted crypto implementation rather than third-party code this project ships. That said, this is not a claim that long-term keys are non-extractable: `engine.ts` currently generates them with `extractable: true`, the same as the original design, because the at-rest encryption scheme below needs the raw private key bytes to encrypt them — Web Crypto's `wrapKey` cannot wrap a non-extractable key either, so switching to non-extractable generation would need a different at-rest scheme, not just a flag flip. Mitigations, unchanged from the original design: long-term private keys are stored encrypted at rest in IndexedDB (encrypted with a key derived from the user's app-lock credential), decrypted into memory only transiently when needed, and a strict CSP (added — see `next.config.js`) is used to sharply reduce the XSS exposure that would matter here. This is documented as a genuine platform limitation, not hand-waved away.

**Android (future, Phase 13–14).** Written when the plan was libsodium everywhere; worth revisiting once Android work actually starts, in light of the same reasoning that moved the web/backend off libsodium. Android's own crypto provider (Conscrypt, via `javax.crypto`) supports X25519, Ed25519, and AES-256-GCM natively on modern API levels, which would mean the same "native platform implementation, no bundled third-party crypto" property web now has, and one fewer set of primitives to keep in sync across platforms. If libsodium is still preferred for Android specifically (e.g. for lower minimum API level support), the note below describes that path — this hasn't been decided either way yet. Android Keystore doesn't natively run arbitrary libsodium operations (X25519/XChaCha20) as hardware-backed operations on all API levels, so the realistic pattern would be: Keystore protects (wraps) the locally-generated libsodium key material at rest, with the wrapping key itself hardware-backed. The libsodium key is only unwrapped into memory transiently. Weaker than "fully hardware-resident," stronger than the web story — worth being precise about rather than just saying "uses the Keystore."
