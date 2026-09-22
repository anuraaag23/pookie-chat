# Threat Model

No system is "100% secure," and this document exists so nobody has to take that claim on faith — it says exactly what's covered and what isn't.

## 1. Assets being protected

1. Message content (text)
2. File/media content
3. Long-term and session private keys
4. Account credentials
5. Metadata, where feasible (who talks to whom, when) — explicitly the *hardest* one, see §4

## 2. Attackers considered

| Attacker | Capability |
|---|---|
| Database thief | Full read of PostgreSQL (breach, insider, subpoena) |
| Drive thief | Full read of the app's Shared Drive (breach, insider, subpoena) |
| Network attacker | Can observe or attempt to tamper with traffic between clients and server |
| Session thief | Has stolen an access/refresh token (XSS, malware, physical access to an unlocked session) |
| Device thief — locked | Has physical possession of a device that is locked (OS lock screen, and/or app lock if enabled) |
| Device thief — unlocked | Has physical possession of a device that is unlocked |
| Pairing guesser | Repeatedly submits pairing codes or hidden-chat PINs, trying to guess |
| Malicious client | Sends malformed/adversarial requests directly to the API, bypassing the real client entirely |
| Server operator | Anthropic-style trust question, but for whoever runs this backend: could they read message content if they wanted to? |

## 3. What the app protects against

- **DB breach exposing message/file content.** Message bodies and file contents are ciphertext end-to-end; the DB never holds a plaintext copy or a usable decryption key for either (see `03-ENCRYPTION-PROTOCOL.md`).
- **Drive breach exposing file content.** Files are encrypted client-side before upload with a random per-file key that itself never touches Drive or, unencrypted, the database.
- **Network eavesdropping.** TLS in transit, on top of content that's already E2E-encrypted — an attacker who somehow broke TLS would still only see ciphertext.
- **Server operator reading content.** By construction, not by policy — the server never possesses a key capable of decrypting message or file content.
- **Pairing code / hidden-chat brute force at scale.** Rate-limited and lockout-protected server-side for pairing codes (see §5 for the one case this doesn't cover).
- **Casual/opportunistic snooping of a device someone picked up.** App lock (PIN/biometric) plus the hidden-chat gate.
- **Stolen session tokens.** Short-lived access tokens, revocable refresh tokens, visible device/session list, new-device alerts.
- **Enumeration/timing leaks about whether a pairing code or hidden-chat PIN exists.** Uniform response shape and timing regardless of whether the input was right, wrong, or not code-shaped at all (detailed in the encryption/design docs).

## 4. What the app explicitly cannot protect against

Say this plainly now so it's never implied otherwise later:

- **A compromised endpoint.** Malware, a keylogger, or a screen-scraper on either device reads plaintext at the point it's displayed or typed — no messaging protocol can prevent that.
- **The other party.** Once a message is decrypted on the recipient's screen, they can screenshot, photograph, retype, or forward it. "Burn Conversation" and disappearing messages remove *your own* copies and, where technically possible, the server's queued copy — they cannot reach into a copy someone already made. This is stated to the user directly in-product wherever these features are surfaced, per your own instruction in §15.
- **Metadata.** Even with content fully hidden, the server necessarily sees *that* a message was sent, roughly *when*, its *size*, and *who* the two paired accounts are. This is the same limitation every messenger with a central server has (Signal included) — it's a hard problem, not a corner we cut.
- **A device that's unlocked in the attacker's hands.** App lock helps against someone grabbing a phone that's asleep-but-not-locked, or deters casual snooping. It does not resist a determined attacker with an already-unlocked device and time — at that point they have the same access the legitimate user does.
- **Loss of the only device with no backup.** Because private keys are never escrowed anywhere (a deliberate choice — see `03-ENCRYPTION-PROTOCOL.md` §8), losing the one device holding them means that side of the conversation's history is genuinely gone. This is the standard trade-off of "no plaintext keys in the database": better security, and recovery means re-pairing, not restoring.
- **Legal compulsion of the server operator, for content.** They'd have ciphertext to hand over, not plaintext. They would still have metadata (§4, "metadata").
- **A weak hidden-chat PIN or app-lock PIN chosen by the user.** No design choice here substitutes for PIN strength — flagged concretely in §5.

## 5. Specific risks in the original spec, flagged now rather than silently shipped

**"Forever" pairing codes.** A never-expiring shared secret sitting around is a bigger brute-force target the longer it exists, even at 1-in-a-million odds per guess. I'm implementing it as requested, but with two mitigations: the create-code UI does not default to it (default is 15 minutes), and selecting "Forever" or anything beyond 7 days shows a plain-language warning before confirming. Rate limiting and per-code lockout apply identically regardless of duration.

**Hidden-chat PIN — and the app-lock PIN, which shares the identical mechanism (`lib/localauth/localSecret.ts`) and therefore the identical limitation — have no server-side backstop, by design.** Recall from `02-DATABASE-SCHEMA.md` that the hidden-chat flag and its PIN verifier live *only* in local encrypted device storage — deliberately, so the server never even learns a hidden conversation exists. The cost of that privacy property: on **web**, there's no hardware-backed retry counter the way a phone's Secure Enclave/Keystore can provide, so the only thing standing against an attacker who extracts the local encrypted store and attacks it offline is the strength of the PIN itself plus PBKDF2's cost. **Recommendation: both credentials should be allowed to be longer than 4 digits** — I'd default the UI to encourage 6+ characters (alphanumeric or a longer numeric PIN) specifically because these are the two credentials in the system without a server able to rate-limit them. On **Android** (Phase 14), we can do meaningfully better by binding this check to a Keystore-backed key with a hardware-enforced attempt limit — noted as a planned platform-specific hardening, not parity with web.

**Single active device per account, for v1.** The schema supports multiple devices, but the initial ratchet implementation (Phase 4) assumes one primary device holding the live session state per conversation, matching your "small number of users, simple product" framing. Multi-device fan-out (re-encrypting each message per device, syncing ratchet state) is real added protocol complexity that I'm scoping out explicitly rather than quietly half-supporting it. Documented as a future enhancement in `05-ROADMAP.md`.

**Simplified ratchet in Phase 4, full Double Ratchet as a hardening item.** The v1 protocol gives forward secrecy for message keys (compromising one message key doesn't expose prior ones). Full Signal-style Double Ratchet additionally gives *post-compromise security* — a session "heals" itself after a compromise via fresh DH steps. That's more complex to implement correctly, so it's called out as a dedicated, tested piece of work in Phase 10 rather than something I wave through as already done in Phase 4. Said plainly: **a from-scratch protocol implementation like this deserves a professional cryptographic audit before it handles real people's sensitive communications at any scale** — I can build it carefully against public, well-reviewed protocol specs and vetted primitives, but I'm not a substitute for that audit, and I won't imply otherwise.

**Google Drive configuration.** Covered in the architecture doc — the risk isn't Drive itself, it's Drive misconfigured (personal account, public links, client-side credentials). The design assumes it's done the one secure way.
