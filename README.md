# Pookie Chat

A private, end-to-end encrypted, one-to-one messaging application. No groups, no public rooms, no social feed, no discoverable profiles — two people, one conversation, encrypted before it ever leaves the device.

**Status: Phases 0–1 done. Phases 2–11 are written and code-reviewed against the real architecture, with a growing body of real, executable domain/unit tests and a from-scratch protocol-level test harness — but still never run inside the actual NestJS/Next.js/PostgreSQL stack in any sandbox so far. Most recently: a full V1 pre-runtime hardening pass across backend correctness, session/sync state, attachment lifecycle, auth/session security, frontend resilience, privacy, and configuration — see `docs/05-ROADMAP.md`'s "V1 pre-runtime hardening pass" section and the final report in-chat for exactly what's verified vs. written-but-unverified.**

## Getting started

This was built in a sandbox with no network access. Real dependencies have never been installed here — you're the first real `npm install`. From the repo root, in an environment with network access:

```bash
# Backend
cd apps/backend
npm install
cp .env.example .env               # fill in real values — see the comments in the file
npm run prisma:generate
npm run prisma:migrate             # needs a real PostgreSQL instance at DATABASE_URL
npm run start:dev                  # → http://localhost:4000/health should return {"status":"ok",...}

# Web (separate terminal)
cd apps/web
npm install
cp .env.example .env.local         # only needed if your backend isn't at the default localhost:4000
npm run dev                        # → http://localhost:3000
```

If anything fails to compile, that's possible — this was written carefully, type-checked with `tsc` wherever this sandbox's tooling allowed, and run with real automated tests wherever it was possible to execute code at all (67 unit tests — see `apps/backend/src/domain/__tests__/`, `apps/backend/src/config/__tests__/`, `apps/web/lib/crypto/__tests__/`, `apps/web/lib/localauth/__tests__/` — plus 157 further checks across the `verification-harness/regression-*.mjs` files, which exercise the real domain logic against a real, if SQLite-backed, database and real network sockets), but the full NestJS/Next.js stack itself was never run end-to-end here. Tell me the exact error and I'll fix it rather than guess.

## What's real vs. what's structurally complete but unverified

- **Verified by actually running it, in this session:** the E2EE engine (X3DH handshake, ratchet, AES-256-GCM, tamper/signature rejection), password hashing, pairing-code generation/verification, session tokens, login lockout, message ordering/idempotency/disappearing-timer logic, the hidden-chat/app-lock secret check including its timing-safety property, boot-time production secret validation (placeholder/length rejection), and a hand-rolled WebSocket protocol implementation — all via real automated tests or direct execution, not by inspection.
- **Written completely and correctly against the real architecture, but not executable in this sandbox:** the NestJS controllers/services/gateway, Prisma-backed persistence, and the Next.js frontend pages — none of these can run without `npm install` and (for the backend) a real Postgres instance, neither of which this sandbox can provide.
- **Written but unverified for a different reason — no real credentials exist to test against:** the Google Drive integration.

See `verification-harness/` for a from-scratch reimplementation of the same protocol on pure Node built-ins, used specifically to prove the pairing → handshake → offline-delivery → live-delivery → read-receipt → block flow end-to-end against a real (if SQLite-backed) database and real network sockets. It found and led to fixing one real design bug in the encryption AAD scheme — see `docs/03-ENCRYPTION-PROTOCOL.md`'s correction note.

## What this is

- Strictly 1:1. Every account can be paired with exactly one other account per conversation, via a one-time 6-digit code.
- The backend and its database are designed to never see plaintext message or file content — only ciphertext, and the minimum metadata needed to route and deliver it.
- Visual language: **neomorphism** as the primary surface treatment, **Liquid Glass** as an accent used only on a handful of interactive elements (search bar, primary buttons). Default palette is black/white plus functional red/green/blue; users may add one custom accent color.
- A "hidden chat" unlockable only through the search bar, disappearing messages, app lock, and a "burn conversation" feature are first-class, not bolted on.

## Documents in this Phase

| Doc | Covers |
|---|---|
| [`docs/00-ARCHITECTURE.md`](docs/00-ARCHITECTURE.md) | System context, tech stack decisions + rationale, data flow for auth/pairing/messaging/media |
| [`docs/01-THREAT-MODEL.md`](docs/01-THREAT-MODEL.md) | Attacker profiles, what the app protects against, what it explicitly cannot |
| [`docs/02-DATABASE-SCHEMA.md`](docs/02-DATABASE-SCHEMA.md) | Entities, relationships, retention/deletion rules |
| [`docs/03-ENCRYPTION-PROTOCOL.md`](docs/03-ENCRYPTION-PROTOCOL.md) | Key hierarchy, pairing handshake, message ratchet, media encryption, what the server can/cannot see |
| [`docs/04-DESIGN-SYSTEM.md`](docs/04-DESIGN-SYSTEM.md) | Neomorphism + Liquid Glass tokens, color rules, accessibility notes |
| [`docs/05-ROADMAP.md`](docs/05-ROADMAP.md) | The 16-phase plan, definition of done per phase, and the final acceptance checklist |
| [`design-preview.html`](design-preview.html) | A static, non-functional visual preview of the design language (chat + pairing screens, light/dark) — for sign-off before Phase 1 builds it for real |

## A note on this environment

This conversation's sandbox has **no outbound network access** (confirmed directly: an npm registry request returned a proxy-level 403). That means from inside this container I cannot run `npm install` against the public registry, connect to a live PostgreSQL instance, call the Google Drive API, or run an Android build. It does not change the plan — it changes where certain steps get *executed*:

- Everything that's pure design/architecture/code, I do here, completely and for real.
- Anything requiring live infrastructure (installing dependencies, running migrations against a real database, hitting Google's APIs, compiling the Android app, running integration/security tests against a running server) needs to happen in an environment with network access — your own machine, a CI runner, or a cloud dev box. I'll hand you exact commands for each, and I will not claim something "passed tests" unless it was actually run somewhere capable of running it.

## Ground rules carried through every phase

- No invented cryptography, no `Base64`-as-encryption, no hardcoded keys, no mock security in place of the real thing.
- No TODOs in security-critical paths, no secrets committed, `.env.example` only.
- If a request would weaken security, I'll say so and propose an alternative before implementing anything — not silently comply, not silently "fix" it without telling you either.
- Nothing is "100% secure." Every phase's docs say plainly what's covered and what isn't.
