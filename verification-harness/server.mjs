// Verification harness — NOT the production server.
//
// The production server is apps/backend (NestJS + Prisma + PostgreSQL),
// written for real in this repo but not executable in this sandbox (no
// network access means no `npm install`, no Prisma engine download, no
// reachable Postgres). This harness reimplements the same API surface on
// top of Node's built-ins (http, node:sqlite) plus the exact same pure
// domain modules (../apps/backend/src/domain/*) the real server imports,
// so that the actual protocol — pairing, handshake relay, encrypted
// message delivery, offline sync, read receipts — can be run and proven
// end-to-end against a real database and real network sockets, rather
// than only asserted in isolated unit tests.
//
// It intentionally skips things the harness doesn't need to prove the
// point: no rate-limiting middleware (the rate-limit *logic* is already
// unit-tested in pairingCode.ts), no CORS/helmet headers (irrelevant on
// loopback), no request size limits. The real backend's controllers
// layer these on top — see apps/backend/src/*.

import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachWebSocketServer } from './mini-ws.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Serving these two static files directly from the harness (rather than a
// second static-file server process) only exists to make the e2e test
// scenario (run_e2e.py) simple to run in this sandbox — it has nothing to
// do with the actual application architecture.
const STATIC_FILES = {
  '/e2e-page.html': { file: 'e2e-page.html', type: 'text/html' },
  '/engine.js': { file: 'engine.js', type: 'application/javascript' },
};

import { hashPassword, verifyPassword } from '../apps/backend/src/domain/password.ts';
import { findMatchingDevice } from '../apps/backend/src/domain/deviceIdentity.ts';
import {
  generatePairingCode,
  hashPairingCode,
  verifyPairingCode,
  computeExpiresAt,
  isExpired,
  isLockedOut,
  recordFailedAttempt,
} from '../apps/backend/src/domain/pairingCode.ts';
import {
  issueAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  hashIp,
} from '../apps/backend/src/domain/tokens.ts';
import { isDuplicateSend, nextSequenceNumber, higherCounterValue, computeSyncGap, resolveDisappearTrigger, computeDisappearAt } from '../apps/backend/src/domain/messageState.ts';
import { isStaleEpoch, isUsableForHandshake } from '../apps/backend/src/domain/sessionEpoch.ts';
import { normalizeUsername, validateUsername, nextUsernameChangeAllowedAt } from '../apps/backend/src/domain/username.ts';
import {
  normalizeEmail,
  validateEmail,
  generateVerificationCode,
  hashVerificationCode,
  verifyVerificationCode,
} from '../apps/backend/src/domain/email.ts';

const ACCESS_TOKEN_SECRET = process.env.HARNESS_ACCESS_SECRET || 'harness-dev-secret-not-for-real-use';
// Mirrors REFRESH_TOKEN_TTL_MS in auth.service.ts.
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Mirrors MAX_SEQUENCE_RETRY_ATTEMPTS in messages.service.ts.
const MAX_SEQUENCE_RETRY_ATTEMPTS = 5;
// Mirrors EXPIRY_SWEEP_INTERVAL_MS in messages.service.ts.
const EXPIRY_SWEEP_INTERVAL_MS = 5_000;
// Mirrors AttachmentsService's ORPHANED_ATTACHMENT_MAX_AGE_MS /
// ORPHAN_SWEEP_INTERVAL_MS — kept much shorter here than the real
// service's hour/5-minute values so a regression test can actually wait
// out the interval-driven path deterministically if it chooses to,
// though every test below drives cleanupOrphanedAttachments() directly
// instead, same reasoning as cleanupExpiredMessages.
const ORPHANED_ATTACHMENT_MAX_AGE_MS = 5_000;
const ORPHAN_SWEEP_INTERVAL_MS = 5_000;

// node:sqlite (used here instead of @prisma/client, which needs a real
// npm install this sandbox has never had) reports a UNIQUE constraint
// violation with err.code === 'ERR_SQLITE_ERROR' (a generic Node-level
// wrapper) — the actual SQLite-specific detail is on err.errcode (2067 =
// SQLITE_CONSTRAINT_UNIQUE) and in err.message. Checking err.code against
// a 'SQLITE_CONSTRAINT*' prefix (an earlier version of this check) never
// actually matched anything, which would have made the retry loops below
// silently never retry — found and fixed while adding this harness's own
// regression test for the fix. Checks both errcode and the message text
// since node:sqlite is still an experimental API whose exact shape isn't
// guaranteed stable across Node versions.
function isSqliteUniqueConstraintError(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.errcode === 2067) return true;
  return typeof err.message === 'string' && err.message.includes('UNIQUE constraint failed');
}

/**
 * The actual retry control flow used by both the send() and edit()
 * handlers below — pulled out to its own named, exported function
 * specifically so it can be unit tested directly (see
 * regression-sync-fix.mjs) against a fake `attempt` that behaves like a
 * real conflicting write, independent of whether node:sqlite's
 * synchronous execution model can ever actually produce that conflict
 * through genuine concurrency (it cannot — see the comment where this is
 * called). This is what lets this specific fix's *logic* (retries on
 * conflict, gives up after maxAttempts, propagates any other error
 * untouched) be verified for real in this sandbox, separate from the
 * true-concurrency question a real Postgres would be needed to answer.
 */
export async function retryOnUniqueConflict(attempt, maxAttempts) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await attempt(i);
    } catch (err) {
      if (isSqliteUniqueConstraintError(err) && i < maxAttempts - 1) continue;
      throw err;
    }
  }
  throw new Error('unreachable');
}
const PAIRING_PEPPER = process.env.HARNESS_PAIRING_PEPPER || 'harness-dev-pepper-not-for-real-use';

export function createHarness() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE,
      email TEXT UNIQUE,
      email_verified_at TEXT,
      username_changed_at TEXT,
      display_name TEXT,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE'
    );
    CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      device_name TEXT,
      platform TEXT NOT NULL,
      identity_dh_public TEXT NOT NULL,
      identity_signing_public TEXT NOT NULL,
      signed_prekey_public TEXT NOT NULL,
      signed_prekey_signature TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE TABLE one_time_prekeys (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL REFERENCES devices(id),
      public_key TEXT NOT NULL,
      used_at TEXT
    );
    CREATE TABLE auth_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      refresh_token_hash TEXT NOT NULL,
      user_agent TEXT,
      ip_hash TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE TABLE pairing_codes (
      id TEXT PRIMARY KEY,
      creator_user_id TEXT NOT NULL,
      code_hmac TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      expires_at TEXT,
      used_by_user_id TEXT,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      UNIQUE(code_hmac, status)
    );
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      user_a_id TEXT NOT NULL,
      user_b_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      session_epoch INTEGER NOT NULL DEFAULT 1,
      disappearing_timer_seconds INTEGER,
      disappearing_trigger TEXT,
      UNIQUE(user_a_id, user_b_id)
    );
    CREATE TABLE pending_handshakes (
      conversation_id TEXT PRIMARY KEY,
      recipient_user_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      session_epoch INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      sequence_number INTEGER NOT NULL,
      sync_version INTEGER NOT NULL,
      client_message_id TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      iv TEXT NOT NULL,
      message_type TEXT NOT NULL DEFAULT 'TEXT',
      reply_to_message_id TEXT,
      sent_at TEXT NOT NULL,
      delivered_at TEXT,
      read_at TEXT,
      edited_at TEXT,
      deleted_at TEXT,
      disappear_at TEXT,
      UNIQUE(conversation_id, sequence_number),
      UNIQUE(conversation_id, client_message_id),
      -- Without this, two concurrent writers computing the same "next"
      -- sync_version (a send racing an edit, or two concurrent edits)
      -- would silently succeed as two rows sharing one value — see
      -- schema.prisma's identical constraint for the full reasoning.
      UNIQUE(conversation_id, sync_version)
    );
    CREATE TABLE user_settings (
      user_id TEXT PRIMARY KEY,
      read_receipts_enabled INTEGER NOT NULL DEFAULT 1,
      typing_indicator_enabled INTEGER NOT NULL DEFAULT 1,
      username_search_enabled INTEGER NOT NULL DEFAULT 1,
      attachment_storage_provider TEXT NOT NULL DEFAULT 'MANAGED'
    );
    CREATE TABLE email_verifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      email TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE google_drive_connections (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      google_account_subject TEXT NOT NULL,
      google_email TEXT,
      encrypted_access_token TEXT NOT NULL,
      encrypted_refresh_token TEXT NOT NULL,
      access_token_expires_at TEXT NOT NULL,
      drive_folder_id TEXT,
      connected_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revoked_at TEXT
    );
    -- Minimal — real upload/download go through Google Drive, which has
    -- never been testable in this sandbox (no credentials, true since
    -- this project's first session). This exists only to let tests seed
    -- a linked attachment directly and verify the cleanup wiring
    -- (AttachmentsService.deleteForMessage's real-backend fix) actually
    -- removes it when its message is deleted or expires — not to mock
    -- the upload/download flow itself.
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      conversation_id TEXT NOT NULL,
      uploader_id TEXT NOT NULL DEFAULT '',
      drive_file_id TEXT NOT NULL,
      storage_provider TEXT NOT NULL DEFAULT 'MANAGED',
      encrypted_dek TEXT,
      uploaded_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'
    );
    CREATE TABLE security_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    );
  `);

  function logSecurityEvent(userId, eventType, metadata = {}) {
    db.prepare(
      'INSERT INTO security_events (id, user_id, event_type, metadata_json, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(randomUUID(), userId, eventType, JSON.stringify(metadata), new Date().toISOString());
  }

  function canonicalPair(a, b) {
    return a < b ? [a, b] : [b, a];
  }

  // userId -> Set<MiniWebSocket> (a user could have >1 connected device/tab)
  const liveConnections = new Map();
  // Mirrors connection-registry.service.ts's new caps — same constants,
  // so a harness test that opens MAX_SOCKETS_PER_USER + 1 connections (or
  // sends TYPING_MAX_PER_WINDOW + 1 typing events) exercises the exact
  // same thresholds the real service enforces.
  const MAX_SOCKETS_PER_USER = 8;
  const typingWindows = new Map();
  const TYPING_WINDOW_MS = 10_000;
  const TYPING_MAX_PER_WINDOW = 30;
  function allowTyping(userId) {
    const now = Date.now();
    const window = typingWindows.get(userId);
    if (!window || now - window.windowStart > TYPING_WINDOW_MS) {
      typingWindows.set(userId, { count: 1, windowStart: now });
      return true;
    }
    if (window.count >= TYPING_MAX_PER_WINDOW) return false;
    window.count += 1;
    return true;
  }

  function pushToUser(userId, payload) {
    const sockets = liveConnections.get(userId);
    if (!sockets) return false;
    let delivered = false;
    for (const ws of sockets) {
      if (ws.isOpen) {
        ws.send(payload);
        delivered = true;
      }
    }
    return delivered;
  }

  // Same sockets, indexed a second way — mirrors ConnectionRegistryService:
  // pushToUser/isOnline answer "is this person reachable at all" (message
  // delivery); pushToDevice/isDeviceOnline/disconnectDevice answer "is
  // THIS specific device reachable" (Devices & Sessions, remote logout).
  const deviceConnections = new Map();
  function pushToDevice(deviceId, payload) {
    const sockets = deviceConnections.get(deviceId);
    if (!sockets) return false;
    let delivered = false;
    for (const ws of sockets) {
      if (ws.isOpen) {
        ws.send(payload);
        delivered = true;
      }
    }
    return delivered;
  }
  function disconnectDevice(deviceId) {
    const sockets = deviceConnections.get(deviceId);
    if (!sockets) return;
    for (const ws of sockets) ws.close();
  }
  function disconnectUser(userId) {
    const sockets = liveConnections.get(userId);
    if (!sockets) return;
    for (const ws of Array.from(sockets)) ws.close();
  }
  function isDeviceOnline(deviceId) {
    return (deviceConnections.get(deviceId)?.size ?? 0) > 0;
  }

  // -------------------------------------------------------------------
  // HTTP handlers
  // -------------------------------------------------------------------

  async function readJsonBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (chunks.length === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  function sendJson(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
    res.end(data);
  }

  // ---------------------------------------------------------------------
  // Minimal, hand-rolled equivalent of the shape/format checks NestJS's
  // ValidationPipe (whitelist+forbidNonWhitelisted+transform: true — see
  // main.ts) applies via class-validator decorators on the real DTOs.
  // This harness never had ANY of this — every field was accepted
  // as-is, regardless of shape. That gap is exactly what let a real bug
  // hide for this project's entire history: the client generated
  // clientMessageId as `${userId}-${Date.now()}-${Math.random()...}`,
  // which is not UUID-shaped, while SendMessageDto has always required
  // @IsUUID() — every real send would have been rejected by NestJS, but
  // every harness-based test (including ones in this very file) kept
  // passing, because nothing here ever checked the shape.
  //
  // This does not attempt to replicate class-validator in full — no
  // decorators, no DTO classes, no whitelist-stripping of unknown
  // properties. It replicates just the two things that actually caught
  // a real bug and are cheap to keep faithful: "is this UUID-shaped" and
  // "is this one of the allowed enum values". Reproducing the *rest* of
  // class-validator's behavior (exact length ceilings, every DTO's every
  // field) is significant, uncertain-value engineering effort in a
  // hand-rolled test double; done here for the fields load-bearing
  // enough that a mismatch would break the real app outright, not
  // attempted exhaustively for every field on every DTO.
  const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function isUuidShaped(value) {
    return typeof value === 'string' && UUID_SHAPE.test(value);
  }
  /** Throws a shape-checked 400 the same way a NestJS ValidationPipe rejection would, for the specific fields this harness checks. Returns nothing on success. */
  function validateShape(body, checks) {
    for (const [field, check] of Object.entries(checks)) {
      const value = body[field];
      if (check.optional && (value === undefined || value === null)) continue;
      if (check.type === 'uuid' && !isUuidShaped(value)) {
        throw new ShapeValidationError(`${field} must be a UUID`);
      }
      if (check.type === 'enum' && !check.values.includes(value)) {
        throw new ShapeValidationError(`${field} must be one of: ${check.values.join(', ')}`);
      }
      if (check.type === 'string' && typeof value !== 'string') {
        throw new ShapeValidationError(`${field} must be a string`);
      }
      if (check.type === 'integer' && !Number.isInteger(value)) {
        throw new ShapeValidationError(`${field} must be an integer`);
      }
      if (check.type === 'object' && (typeof value !== 'object' || value === null || Array.isArray(value))) {
        throw new ShapeValidationError(`${field} must be an object`);
      }
    }
  }
  class ShapeValidationError extends Error {}

  /** Server-observed, never trusted from the request body — mirrors auth.controller.ts's requestContext. */
  function requestContext(req) {
    return { userAgent: req.headers['user-agent'], ip: req.socket?.remoteAddress };
  }

  function authenticate(req) {
    const auth = req.headers['authorization'];
    if (!auth?.startsWith('Bearer ')) return null;
    const payload = verifyAccessToken(auth.slice('Bearer '.length), ACCESS_TOKEN_SECRET);
    if (!payload) return null;
    // Cryptographically valid and unexpired is not the same as still
    // authorized — mirrors AccessTokenGuard's new check.
    const device = db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(payload.deviceId);
    if (!device || device.revoked_at) return null;
    return payload;
  }

  async function handleRequest(req, res) {
    // Permissive CORS here ONLY because this harness's test page and API
    // happen to run on two different localhost ports for convenience. The
    // real backend (apps/backend/src/main.ts) locks CORS to the single
    // configured WEB_ORIGIN — this is not the production configuration.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    try {
      if (req.method === 'GET' && STATIC_FILES[path]) {
        const { file, type } = STATIC_FILES[path];
        const content = await readFile(`${__dirname}/${file}`);
        res.writeHead(200, { 'Content-Type': type });
        res.end(content);
        return;
      }

      // ---- Auth ----
      if (req.method === 'POST' && path === '/api/auth/register') {
        const body = await readJsonBody(req);
        // Mirrors RegisterDto's @Transform (trim+lowercase) then
        // @IsUsername() — same two real functions the actual DTO's
        // decorator calls, not a reimplementation of the policy.
        const username = normalizeUsername(typeof body.username === 'string' ? body.username : '');
        const usernameCheck = validateUsername(username);
        if (!usernameCheck.valid) {
          throw new ShapeValidationError(usernameCheck.error ?? 'Invalid username');
        }
        let email = null;
        if (body.email !== undefined && body.email !== null && String(body.email).trim() !== '') {
          email = normalizeEmail(typeof body.email === 'string' ? body.email : '');
          const emailCheck = validateEmail(email);
          if (!emailCheck.valid) {
            throw new ShapeValidationError(emailCheck.error ?? 'Invalid email');
          }
        }
        const userId = randomUUID();
        const passwordHash = await hashPassword(body.password);
        try {
          db.prepare('INSERT INTO users (id, password_hash, username, email, created_at) VALUES (?, ?, ?, ?, ?)').run(
            userId,
            passwordHash,
            username,
            email,
            new Date().toISOString(),
          );
        } catch (err) {
          // Mirrors AuthService.register's P2002 handling — the DB's own
          // unique constraint is the real authority on uniqueness,
          // exactly as it is against real Postgres.
          if (isSqliteUniqueConstraintError(err)) {
            if (email && String(err.message).includes('users.email')) {
              return sendJson(res, 409, { error: 'An account with that email already exists' });
            }
            return sendJson(res, 409, { error: 'That username is already taken' });
          }
          throw err;
        }

        if (email) {
          const rawCode = generateVerificationCode();
          const codeHash = hashVerificationCode(rawCode);
          const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
          db.prepare('INSERT INTO email_verifications (id, user_id, email, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
            randomUUID(),
            userId,
            email,
            codeHash,
            expiresAt,
            new Date().toISOString(),
          );
        }

        const { deviceId } = findOrCreateDeviceRow(userId, body);
        const tokens = issueSession(userId, deviceId, requestContext(req));
        logSecurityEvent(userId, 'NEW_DEVICE', { deviceName: body.deviceName });
        return sendJson(res, 201, {
          userId,
          username,
          email: email ?? undefined,
          emailVerificationRequired: !!email,
          nextUsernameChangeAllowedAt: null,
          deviceId,
          ...tokens,
        });
      }

      // Mirrors AuthController.usernameAvailability — unauthenticated
      // (registration hasn't happened yet), advisory only (see the real
      // register() comment on why the DB write remains authoritative).
      if (req.method === 'GET' && path === '/api/auth/username-availability') {
        const raw = url.searchParams.get('username') ?? '';
        const username = normalizeUsername(raw);
        const usernameCheck = validateUsername(username);
        if (!usernameCheck.valid) return sendJson(res, 200, { available: false });
        const existing = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
        return sendJson(res, 200, { available: !existing });
      }

      // Mirrors AuthController.changeUsername -> AuthService.changeUsername.
      if (req.method === 'PATCH' && path === '/api/auth/username') {
        const auth = authenticate(req);
        if (!auth) return sendJson(res, 401, { error: 'Unauthorized' });
        const body = await readJsonBody(req);
        const newUsername = normalizeUsername(typeof body.username === 'string' ? body.username : '');
        const usernameCheck = validateUsername(newUsername);
        if (!usernameCheck.valid) throw new ShapeValidationError(usernameCheck.error ?? 'Invalid username');

        const user = db.prepare('SELECT username, username_changed_at FROM users WHERE id = ?').get(auth.userId);
        if (newUsername === user.username) {
          return sendJson(res, 409, { error: 'That is already your username.' });
        }
        const changedAt = user.username_changed_at ? new Date(user.username_changed_at) : null;
        const nextAllowed = nextUsernameChangeAllowedAt(changedAt);
        if (nextAllowed && nextAllowed > new Date()) {
          return sendJson(res, 403, {
            error: `You can change your username again on ${nextAllowed.toISOString().slice(0, 10)}.`,
            nextUsernameChangeAllowedAt: nextAllowed.toISOString(),
          });
        }
        const now = new Date();
        try {
          db.prepare('UPDATE users SET username = ?, username_changed_at = ? WHERE id = ?').run(newUsername, now.toISOString(), auth.userId);
        } catch (err) {
          if (isSqliteUniqueConstraintError(err)) {
            return sendJson(res, 409, { error: 'That username is already taken' });
          }
          throw err;
        }
        return sendJson(res, 200, { username: newUsername, nextUsernameChangeAllowedAt: nextUsernameChangeAllowedAt(now).toISOString() });
      }

      if (req.method === 'POST' && path === '/api/auth/verify-email') {
        const body = await readJsonBody(req);
        const email = normalizeEmail(body.email || '');
        const code = String(body.code || '').trim();
        if (!email || !code) {
          return sendJson(res, 400, { error: 'Email and verification code are required' });
        }
        const user = db.prepare('SELECT id, email_verified_at FROM users WHERE lower(email) = ?').get(email);
        if (!user) {
          return sendJson(res, 400, { error: 'Invalid or expired verification code' });
        }
        const record = db.prepare(
          'SELECT * FROM email_verifications WHERE user_id = ? AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1'
        ).get(user.id);
        if (!record) {
          return sendJson(res, 400, { error: 'Invalid or expired verification code' });
        }
        if (new Date(record.expires_at) < new Date()) {
          return sendJson(res, 400, { error: 'Verification code has expired' });
        }
        if (record.attempts >= 5) {
          return sendJson(res, 429, { error: 'Too many failed verification attempts. Please request a new code.' });
        }
        const matches = verifyVerificationCode(code, record.code_hash);
        if (!matches) {
          db.prepare('UPDATE email_verifications SET attempts = attempts + 1 WHERE id = ?').run(record.id);
          return sendJson(res, 400, { error: 'Invalid verification code' });
        }
        const now = new Date().toISOString();
        db.prepare('UPDATE email_verifications SET consumed_at = ? WHERE id = ?').run(now, record.id);
        db.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?').run(now, user.id);
        return sendJson(res, 200, { verified: true });
      }

      if (req.method === 'POST' && path === '/api/auth/resend-verification') {
        const body = await readJsonBody(req);
        const email = normalizeEmail(body.email || '');
        if (!email) {
          return sendJson(res, 400, { error: 'Email is required' });
        }
        const user = db.prepare('SELECT id, email_verified_at FROM users WHERE lower(email) = ?').get(email);
        if (user && !user.email_verified_at) {
          const recent = db.prepare(
            'SELECT created_at FROM email_verifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1'
          ).get(user.id);
          if (recent && Date.now() - new Date(recent.created_at).getTime() < 60_000) {
            return sendJson(res, 429, { error: 'Please wait before requesting another code' });
          }
          const rawCode = generateVerificationCode();
          const codeHash = hashVerificationCode(rawCode);
          const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
          db.prepare('INSERT INTO email_verifications (id, user_id, email, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
            randomUUID(),
            user.id,
            email,
            codeHash,
            expiresAt,
            new Date().toISOString(),
          );
        }
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'POST' && path === '/api/auth/login') {
        const body = await readJsonBody(req);
        const rawId = (body.identifier ?? body.userId ?? '').trim();
        const normalized = rawId.toLowerCase();
        let user = db.prepare('SELECT * FROM users WHERE lower(username) = ? OR id = ?').get(normalized, rawId);
        let matchedByEmail = false;
        if (!user && rawId.includes('@')) {
          user = db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(normalized);
          if (user) matchedByEmail = true;
        }
        if (!user || !(await verifyPassword(body.password, user.password_hash))) {
          // Deliberately identical response whether the user doesn't exist
          // or the password is wrong — no account-enumeration signal.
          return sendJson(res, 401, { error: 'Invalid credentials' });
        }
        if (matchedByEmail && !user.email_verified_at) {
          return sendJson(res, 401, { error: 'Please verify your email before signing in.' });
        }
        const { deviceId, isNewDevice } = findOrCreateDeviceRow(user.id, body);
        const tokens = issueSession(user.id, deviceId, requestContext(req));
        // Only a genuinely new device is worth a security event — a
        // recognized device (the point of findOrCreateDeviceRow) logging
        // in again is routine, matching auth.service.ts's login().
        if (isNewDevice) logSecurityEvent(user.id, 'NEW_DEVICE', { deviceName: body.deviceName });
        return sendJson(res, 200, {
          userId: user.id,
          username: user.username,
          nextUsernameChangeAllowedAt: nextUsernameChangeAllowedAt(user.username_changed_at ? new Date(user.username_changed_at) : null)?.toISOString() ?? null,
          deviceId,
          ...tokens,
        });
      }

      // Mirrors AuthController.changePassword -> AuthService.changePassword:
      // the current password is verified server-side against the stored
      // hash before anything is written, regardless of how valid the
      // caller's access token is.
      if (req.method === 'PATCH' && path === '/api/auth/password') {
        const auth = authenticate(req);
        if (!auth) return sendJson(res, 401, { error: 'Unauthorized' });
        const body = await readJsonBody(req);
        if (typeof body.newPassword !== 'string' || body.newPassword.length < 8) {
          throw new ShapeValidationError('newPassword must be at least 8 characters');
        }
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(auth.userId);
        if (!user || !(await verifyPassword(body.currentPassword ?? '', user.password_hash))) {
          return sendJson(res, 401, { error: 'Current password is incorrect' });
        }
        const newHash = await hashPassword(body.newPassword);
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, auth.userId);
        return sendJson(res, 200, { ok: true });
      }
      // this harness — found during the final V1 pre-runtime audit that
      // refresh/rotation had never been exercised by any regression test
      // in this project's history, despite being one of the most
      // security-critical flows in the app (and despite THE FIX below
      // existing as a real bug in the actual backend, undetected until
      // now for exactly that reason).
      if (req.method === 'POST' && path === '/api/auth/refresh') {
        const body = await readJsonBody(req);
        const tokenHash = hashRefreshToken(body.refreshToken ?? '');
        const session = db
          .prepare("SELECT * FROM auth_sessions WHERE refresh_token_hash = ? AND revoked_at IS NULL AND expires_at > ?")
          .get(tokenHash, new Date().toISOString());
        if (!session) return sendJson(res, 401, { error: 'Session expired or revoked' });
        const device = db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(session.device_id);
        if (!device || device.revoked_at) return sendJson(res, 401, { error: 'Session expired or revoked' });

        // THE FIX: rotation is guarded by the OLD hash still matching,
        // exactly like pairing-code redemption's own concurrent-redeem
        // guard — see auth.service.ts's comment on this same fix for the
        // full reasoning. Without the `refresh_token_hash = ?` half of
        // this WHERE clause, two concurrent refreshes presenting the
        // same valid token would both pass the check above and both
        // write, and whichever landed last would silently strand the
        // other with a token that was already dead on arrival.
        const newRefreshToken = generateRefreshToken();
        const rotated = db
          .prepare('UPDATE auth_sessions SET refresh_token_hash = ?, expires_at = ? WHERE id = ? AND refresh_token_hash = ?')
          .run(hashRefreshToken(newRefreshToken), new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString(), session.id, tokenHash);
        if (rotated.changes === 0) return sendJson(res, 401, { error: 'Session expired or revoked' }); // lost the race to a concurrent refresh
        const accessToken = issueAccessToken({ userId: session.user_id, deviceId: session.device_id }, ACCESS_TOKEN_SECRET);
        return sendJson(res, 200, { accessToken, refreshToken: newRefreshToken });
      }

      // Mirrors AuthService.logout(): revokes whichever session this
      // specific refresh token belongs to. Deliberately tolerant of an
      // already-invalid token (not-found/already-revoked isn't
      // distinguished from a successful logout) — same reasoning as
      // idempotent session revocation elsewhere in this file: a client
      // retrying a logout call that already landed shouldn't see an
      // error for it.
      if (req.method === 'POST' && path === '/api/auth/logout') {
        const body = await readJsonBody(req);
        const tokenHash = hashRefreshToken(body.refreshToken ?? '');
        db.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE refresh_token_hash = ?').run(new Date().toISOString(), tokenHash);
        return sendJson(res, 200, { ok: true });
      }

      // ---- Sessions (Devices & Sessions) ----
      if (req.method === 'GET' && path === '/api/auth/sessions') {
        const auth = authenticate(req);
        if (!auth) return sendJson(res, 401, { error: 'Unauthorized' });
        const rows = db
          .prepare(
            `SELECT s.id, s.device_id, s.user_agent, s.created_at, d.device_name, d.platform, d.last_seen_at
             FROM auth_sessions s JOIN devices d ON d.id = s.device_id
             WHERE s.user_id = ? AND s.revoked_at IS NULL ORDER BY s.created_at DESC`,
          )
          .all(auth.userId);
        return sendJson(
          res,
          200,
          rows.map((s) => ({
            id: s.id,
            deviceId: s.device_id,
            deviceName: s.device_name,
            platform: s.platform,
            userAgent: s.user_agent,
            createdAt: s.created_at,
            lastSeenAt: s.last_seen_at,
            isCurrentDevice: s.device_id === auth.deviceId,
            online: isDeviceOnline(s.device_id),
          })),
        );
      }

      if (req.method === 'DELETE' && path.match(/^\/api\/auth\/sessions\/[^/]+$/)) {
        const auth = authenticate(req);
        if (!auth) return sendJson(res, 401, { error: 'Unauthorized' });
        const sessionId = path.split('/')[4];
        const session = db.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(sessionId);
        // Same 404 whether it doesn't exist or belongs to someone else —
        // no confirmation that a given session id is valid for a
        // different account. Mirrors revokeSession's ownership check.
        if (!session || session.user_id !== auth.userId) return sendJson(res, 404, { error: 'Session not found' });
        if (session.revoked_at) return sendJson(res, 200, { ok: true }); // idempotent — already revoked is a no-op, not an error
        revokeSessionAndDisconnect(sessionId, session.device_id);
        logSecurityEvent(auth.userId, 'SESSION_REVOKED', { sessionId });
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'POST' && path === '/api/auth/sessions/revoke-others') {
        const auth = authenticate(req);
        if (!auth) return sendJson(res, 401, { error: 'Unauthorized' });
        const others = db
          .prepare('SELECT * FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL AND device_id != ?')
          .all(auth.userId, auth.deviceId);
        for (const session of others) revokeSessionAndDisconnect(session.id, session.device_id);
        if (others.length > 0) {
          logSecurityEvent(auth.userId, 'SESSION_REVOKED', { count: others.length, reason: 'revoke_others' });
        }
        return sendJson(res, 200, { revokedCount: others.length });
      }

      // SECURITY AUDIT F5: Account deletion explicitly disconnects the user's
      // active WebSocket connections, mirrors auth.service.ts's deleteAccount.
      if (req.method === 'DELETE' && path === '/api/auth/account') {
        const auth = authenticate(req);
        if (!auth) return sendJson(res, 401, { error: 'Unauthorized' });
        const body = await readJsonBody(req);
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(auth.userId);
        if (!user || !(await verifyPassword(body.password || '', user.password_hash))) {
          return sendJson(res, 401, { error: 'Invalid credentials' });
        }
        const conversations = db
          .prepare('SELECT id, user_a_id, user_b_id FROM conversations WHERE user_a_id = ? OR user_b_id = ?')
          .all(auth.userId, auth.userId);
        for (const convo of conversations) {
          const otherUserId = convo.user_a_id === auth.userId ? convo.user_b_id : convo.user_a_id;
          pushToUser(otherUserId, { type: 'conversation_burned', conversationId: convo.id });
        }
        disconnectUser(auth.userId);
        db.prepare('DELETE FROM one_time_prekeys WHERE device_id IN (SELECT id FROM devices WHERE user_id = ?)').run(auth.userId);
        db.prepare('DELETE FROM devices WHERE user_id = ?').run(auth.userId);
        db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(auth.userId);
        db.prepare('DELETE FROM user_settings WHERE user_id = ?').run(auth.userId);
        db.prepare('DELETE FROM pairing_codes WHERE creator_user_id = ?').run(auth.userId);
        db.prepare('UPDATE pairing_codes SET used_by_user_id = NULL WHERE used_by_user_id = ?').run(auth.userId);
        db.prepare('DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE user_a_id = ? OR user_b_id = ?)').run(auth.userId, auth.userId);
        db.prepare('DELETE FROM pending_handshakes WHERE conversation_id IN (SELECT id FROM conversations WHERE user_a_id = ? OR user_b_id = ?)').run(auth.userId, auth.userId);
        db.prepare('DELETE FROM conversations WHERE user_a_id = ? OR user_b_id = ?').run(auth.userId, auth.userId);
        db.prepare('DELETE FROM users WHERE id = ?').run(auth.userId);
        return sendJson(res, 200, { ok: true });
      }

      // ---- Pairing ----
      if (req.method === 'POST' && path === '/api/pairing/create') {
        const auth = authenticate(req);
        if (!auth) return sendJson(res, 401, { error: 'Unauthorized' });
        const body = await readJsonBody(req);
        const expiresAt = computeExpiresAt(body.durationSeconds ?? null)?.toISOString() ?? null;
        // THE FIX (mirrors pairing.service.ts's real fix, found during the
        // final V1 pre-runtime audit): a 6-digit code is only 1,000,000
        // possible values, and two different users generating the
        // identical code while both are simultaneously ACTIVE hits the
        // same UNIQUE(code_hmac, status) constraint this table already
        // declares — retry with a fresh code rather than letting an
        // ordinary, legitimate request 500 on bad luck.
        const result = await retryOnUniqueConflict((attemptIndex) => {
          const code = generatePairingCode();
          const id = randomUUID();
          db.prepare('INSERT INTO pairing_codes (id, creator_user_id, code_hmac, expires_at) VALUES (?, ?, ?, ?)').run(
            id,
            auth.userId,
            hashPairingCode(code, PAIRING_PEPPER),
            expiresAt,
          );
          return { pairingId: id, code };
        }, 5);
        return sendJson(res, 201, result);
      }

      if (req.method === 'POST' && path === '/api/pairing/redeem') {
        const auth = authenticate(req);
        if (!auth) return sendJson(res, 401, { error: 'Unauthorized' });
        const body = await readJsonBody(req);
        validateShape(body, { code: { type: 'string' } }); // RedeemPairingDto: @Length(6, 6) — length itself isn't checked here (low bug-risk: always server-generated digits), just that it's a string at all

        const candidates = db.prepare("SELECT * FROM pairing_codes WHERE status = 'ACTIVE'").all();
        const match = candidates.find((c) => verifyPairingCode(body.code, PAIRING_PEPPER, c.code_hmac));

        if (!match) {
          // isLockedOut/recordFailedAttempt were imported here but never
          // actually called — same dead-wiring gap as the real
          // pairing.service.ts, found the same way (re-verifying pairing
          // security end to end). See that file's redeem() for the full
          // reasoning on why a wrong guess is treated as pressure
          // against every currently-active code rather than one
          // specific (unidentifiable) target.
          for (const c of candidates) {
            const result = recordFailedAttempt({ failedAttempts: c.failed_attempts, lockedUntil: c.locked_until ? new Date(c.locked_until) : null });
            db.prepare('UPDATE pairing_codes SET failed_attempts = ?, locked_until = ? WHERE id = ?').run(
              result.failedAttempts,
              result.lockedUntil ? result.lockedUntil.toISOString() : null,
              c.id,
            );
          }
          // Same generic error whether the code never existed, already
          // expired, or was just plain wrong — no enumeration signal.
          return sendJson(res, 400, { error: 'Invalid or expired code' });
        }
        if (isLockedOut({ failedAttempts: match.failed_attempts, lockedUntil: match.locked_until ? new Date(match.locked_until) : null })) {
          return sendJson(res, 400, { error: 'Invalid or expired code' });
        }
        if (isExpired(match.expires_at ? new Date(match.expires_at) : null)) {
          db.prepare("UPDATE pairing_codes SET status = 'EXPIRED' WHERE id = ?").run(match.id);
          return sendJson(res, 400, { error: 'Invalid or expired code' });
        }
        if (match.creator_user_id === auth.userId) {
          return sendJson(res, 400, { error: 'Cannot pair with yourself' });
        }

        // Checked before consuming the code or touching the conversation
        // row — same fix, same reasoning, as pairing.service.ts: a
        // creator whose only device has since been revoked now fails
        // cleanly instead of the code being burned (and, for a
        // re-pair-after-burn, the conversation already reactivated with
        // a bumped epoch) out from under a redemption that was about to
        // fail anyway.
        const creatorDevice = db
          .prepare('SELECT * FROM devices WHERE user_id = ? AND revoked_at IS NULL LIMIT 1')
          .get(match.creator_user_id);
        if (!creatorDevice) return sendJson(res, 400, { error: 'Invalid or expired code' });

        // SECURITY AUDIT F1 FIX (mirrors pairing.service.ts's real fix):
        // checked here, before consuming the code or touching the
        // conversation row at all — same "check before mutating" placement
        // as the creatorDevice check just above, and the same reasoning.
        // The "existing row → reactivate to ACTIVE" branch below used to
        // run unconditionally, with no check of the row's *current* status
        // — including BLOCKED_BY_A/BLOCKED_BY_B. That silently lifted a
        // block the harness's own /block route had set, without the
        // blocking party ever calling unblock() (only the person who
        // blocked may lift it — see conversations.service.ts's unblock()).
        // Fixed by rejecting up front whenever the canonical conversation
        // for this pair is currently blocked: same generic "Invalid or
        // expired code" response, no status change, no session_epoch bump,
        // and the pairing code itself is never marked USED — so there is
        // nothing to roll back and no partial state of any kind. Checking
        // before any write, in a handler that (like the rest of this file)
        // runs every statement synchronously with no `await` in between,
        // also means there's no interleaving window between this check and
        // any write for a concurrent request to race into.
        const [userAId, userBId] = canonicalPair(match.creator_user_id, auth.userId);
        const existingForBlockCheck = db
          .prepare('SELECT status FROM conversations WHERE user_a_id = ? AND user_b_id = ?')
          .get(userAId, userBId);
        if (existingForBlockCheck && (existingForBlockCheck.status === 'BLOCKED_BY_A' || existingForBlockCheck.status === 'BLOCKED_BY_B')) {
          return sendJson(res, 400, { error: 'Invalid or expired code' });
        }

        db.prepare("UPDATE pairing_codes SET status = 'USED', used_by_user_id = ? WHERE id = ?").run(
          auth.userId,
          match.id,
        );

        const existing = db
          .prepare('SELECT * FROM conversations WHERE user_a_id = ? AND user_b_id = ?')
          .get(userAId, userBId);
        const conversationId = existing?.id ?? randomUUID();
        if (!existing) {
          db.prepare('INSERT INTO conversations (id, user_a_id, user_b_id) VALUES (?, ?, ?)').run(
            conversationId,
            userAId,
            userBId,
          );
        } else {
          // Re-pairing reuses this row (docs/02-DATABASE-SCHEMA.md) — which
          // requires resetting it. Burn sets status DELETED; leaving that
          // untouched here left every subsequent send/sync permanently
          // rejected for this pair. Same bug, same fix, as pairing.service.ts.
          //
          // session_epoch always advances on redemption — not only after a
          // burn, since every redemption begins a brand-new X3DH handshake
          // regardless of why the conversation needed re-pairing. `x = x + 1`
          // in a single UPDATE statement, mirroring Prisma's atomic
          // `increment` in pairing.service.ts (not a read-then-write) — see
          // domain/sessionEpoch.ts for the full contract this maintains.
          db.prepare("UPDATE conversations SET status = 'ACTIVE', session_epoch = session_epoch + 1 WHERE id = ?").run(conversationId);
        }
        const conversationRow = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);

        const oneTimePrekey = db
          .prepare('SELECT * FROM one_time_prekeys WHERE device_id = ? AND used_at IS NULL LIMIT 1')
          .get(creatorDevice.id);
        if (oneTimePrekey) {
          db.prepare('UPDATE one_time_prekeys SET used_at = ? WHERE id = ?').run(
            new Date().toISOString(),
            oneTimePrekey.id,
          );
        }

        logSecurityEvent(match.creator_user_id, 'NEW_PAIRING', { conversationId });
        logSecurityEvent(auth.userId, 'NEW_PAIRING', { conversationId });

        return sendJson(res, 200, {
          conversationId,
          sessionEpoch: conversationRow.session_epoch,
          bundle: {
            identityDhPublic: creatorDevice.identity_dh_public,
            identitySigningPublic: creatorDevice.identity_signing_public,
            signedPrekeyPublic: creatorDevice.signed_prekey_public,
            signedPrekeySignature: creatorDevice.signed_prekey_signature,
            oneTimePrekeyPublic: oneTimePrekey?.public_key,
          },
        });
      }

      // ---- Handshake relay (server never sees private keys or plaintext) ----
      if (req.method === 'POST' && path === '/api/handshake') {
        const auth = authenticate(req);
        if (!auth) return sendJson(res, 401, { error: 'Unauthorized' });
        const body = await readJsonBody(req);
        validateShape(body, {
          conversationId: { type: 'uuid' },
          handshakeMessage: { type: 'object' },
          sessionEpoch: { type: 'integer' },
        });
        const convo = db.prepare('SELECT * FROM conversations WHERE id = ?').get(body.conversationId);
        if (!convo) return sendJson(res, 404, { error: 'Not found' });
        // Mirrors HandshakeService.store's ownership check — the harness
        // previously computed recipientId with no ownership check at all
        // (a non-participant would fall into the `user_a_id` branch by
        // default), which the real NestJS service has always rejected.
        if (convo.user_a_id !== auth.userId && convo.user_b_id !== auth.userId) {
          return sendJson(res, 403, { error: 'Forbidden' });
        }
        if (!isUsableForHandshake(convo.status)) {
          return sendJson(res, 403, { error: 'Conversation not available' });
        }
        if (isStaleEpoch(body.sessionEpoch, convo.session_epoch)) {
          return sendJson(res, 409, { error: 'This pairing has been superseded — request a fresh pairing code and try again.' });
        }
        const recipientId = convo.user_a_id === auth.userId ? convo.user_b_id : convo.user_a_id;
        db.prepare(
          'INSERT OR REPLACE INTO pending_handshakes (conversation_id, recipient_user_id, payload_json, session_epoch) VALUES (?, ?, ?, ?)',
        ).run(body.conversationId, recipientId, JSON.stringify(body.handshakeMessage), convo.session_epoch);
        return sendJson(res, 201, { ok: true });
      }

      if (req.method === 'GET' && path === '/api/handshake') {
        const auth = authenticate(req);
        if (!auth) return sendJson(res, 401, { error: 'Unauthorized' });
        const conversationId = url.searchParams.get('conversationId');
        const convo = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
        // Same "nothing valid for you" response whether the conversation
        // doesn't exist, was never paired, or was burned and never
        // re-paired — mirrors HandshakeService.fetch.
        if (!convo || !isUsableForHandshake(convo.status)) {
          return sendJson(res, 404, { error: 'No pending handshake' });
        }
        const row = db
          .prepare('SELECT * FROM pending_handshakes WHERE conversation_id = ? AND recipient_user_id = ?')
          .get(conversationId, auth.userId);
        if (!row) return sendJson(res, 404, { error: 'No pending handshake' });
        // Defense in depth beyond store()'s own check — see
        // HandshakeService.fetch's comment on the same check.
        if (isStaleEpoch(row.session_epoch, convo.session_epoch)) {
          return sendJson(res, 404, { error: 'No pending handshake' });
        }
        return sendJson(res, 200, { handshakeMessage: JSON.parse(row.payload_json), sessionEpoch: row.session_epoch });
      }

      // ---- Messaging ----
      if (req.method === 'POST' && path === '/api/messages') {
        const auth = authenticate(req);
        if (!auth) return sendJson(res, 401, { error: 'Unauthorized' });
        const body = await readJsonBody(req);
        // Mirrors SendMessageDto — this is the check that would have
        // caught this project's real clientMessageId/@IsUUID() bug (see
        // validateShape's comment) the moment any test exercised it,
        // instead of it silently working against this harness for the
        // entire time nothing here checked shapes at all.
        validateShape(body, {
          conversationId: { type: 'uuid' },
          clientMessageId: { type: 'uuid' },
          ciphertext: { type: 'string' },
          iv: { type: 'string' },
          messageType: { type: 'enum', values: ['TEXT', 'IMAGE', 'FILE'] },
          sessionEpoch: { type: 'integer' },
          replyToMessageId: { type: 'uuid', optional: true },
          attachmentId: { type: 'uuid', optional: true },
          encryptedDek: { type: 'string', optional: true },
        });
        const convo = db.prepare('SELECT * FROM conversations WHERE id = ?').get(body.conversationId);
        if (!convo || convo.status !== 'ACTIVE') return sendJson(res, 403, { error: 'Conversation not available' });
        if (convo.user_a_id !== auth.userId && convo.user_b_id !== auth.userId) {
          return sendJson(res, 403, { error: 'Not a participant' });
        }
        // The hard backstop against a stale-session send — mirrors
        // MessagesService.send's check. The ACTIVE check above alone
        // cannot distinguish a legitimate current session from one
        // that's been superseded by a burn+re-pair, since re-pairing
        // also leaves status ACTIVE.
        if (isStaleEpoch(body.sessionEpoch, convo.session_epoch)) {
          return sendJson(res, 409, { error: 'STALE_SESSION_EPOCH', currentSessionEpoch: convo.session_epoch });
        }

        // SECURITY AUDIT F6: If replyToMessageId is provided, the referenced
        // message must exist and belong to this same conversation.
        if (body.replyToMessageId) {
          const referenced = db
            .prepare('SELECT id FROM messages WHERE id = ? AND conversation_id = ?')
            .get(body.replyToMessageId, body.conversationId);
          if (!referenced) {
            return sendJson(res, 404, { error: 'Referenced reply message not found' });
          }
        }

        const existingForConvo = db
          .prepare('SELECT client_message_id, id, sequence_number FROM messages WHERE conversation_id = ?')
          .all(body.conversationId)
          .map((m) => ({ clientMessageId: m.client_message_id, conversationId: body.conversationId }));

        if (isDuplicateSend(body.clientMessageId, body.conversationId, existingForConvo)) {
          const existingRow = db
            .prepare('SELECT * FROM messages WHERE conversation_id = ? AND client_message_id = ?')
            .get(body.conversationId, body.clientMessageId);
          return sendJson(res, 200, { id: existingRow.id, sequenceNumber: existingRow.sequence_number, deduped: true });
        }

        // Race note: node:sqlite's DatabaseSync executes every statement
        // here synchronously with no `await` between the MAX computation
        // and the INSERT, so — unlike real concurrent Postgres connections
        // — this harness cannot actually interleave two requests between
        // those two statements. retryOnUniqueConflict below exists for
        // parity with messages.service.ts's real fix (so this harness
        // doesn't silently diverge from what the real backend does under
        // a genuine race), and its own control-flow logic is verified
        // directly in regression-sync-fix.mjs against a fake conflicting
        // write — but a *real* collision through genuine concurrency is
        // not exercisable through this harness. Documented, not glossed
        // over, in the final report.
        const recipientId = convo.user_a_id === auth.userId ? convo.user_b_id : convo.user_a_id;
        // Mirrors send()'s disappearAt computation for the 'sent' trigger
        // — the 'delivered'/'read' triggers are computed later, at the
        // point those events actually happen, same as the real service.
        let disappearAt = null;
        if (convo.disappearing_timer_seconds && convo.disappearing_trigger) {
          const recipientSettings = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(recipientId);
          const trigger = resolveDisappearTrigger({
            timerSeconds: convo.disappearing_timer_seconds,
            trigger: convo.disappearing_trigger.toLowerCase(),
            readReceiptsEnabled: recipientSettings ? !!recipientSettings.read_receipts_enabled : true,
          });
          if (trigger === 'sent') {
            disappearAt = computeDisappearAt(
              { timerSeconds: convo.disappearing_timer_seconds, trigger: 'sent', readReceiptsEnabled: true },
              { sentAt: new Date() },
            ).toISOString();
          }
        }
        let sequenceNumber;
        let id;
        let sentAt;
        await retryOnUniqueConflict(() => {
          const maxSeqRow = db
            .prepare('SELECT MAX(sequence_number) as maxSeq, MAX(sync_version) as maxSyncVersion FROM messages WHERE conversation_id = ?')
            .get(body.conversationId);
          const currentMax = higherCounterValue(maxSeqRow.maxSeq, maxSeqRow.maxSyncVersion);
          sequenceNumber = Number(nextSequenceNumber(currentMax));
          id = randomUUID();
          sentAt = new Date().toISOString();
          db.prepare(
            `INSERT INTO messages (id, conversation_id, sender_id, sequence_number, sync_version, client_message_id, ciphertext, iv, message_type, reply_to_message_id, sent_at, disappear_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            id,
            body.conversationId,
            auth.userId,
            sequenceNumber,
            sequenceNumber, // sync_version starts equal to sequence_number
            body.clientMessageId,
            body.ciphertext,
            body.iv,
            body.messageType || 'TEXT',
            body.replyToMessageId || null,
            sentAt,
            disappearAt,
          );
        }, MAX_SEQUENCE_RETRY_ATTEMPTS);

        // THE FIX (mirrors the real backend's fix — see
        // AttachmentsService.linkToMessage's own doc comment for the
        // full story): attachmentId alone is sufficient to link; a
        // missing encryptedDek is not an error, since the real frontend
        // never sends one — the DEK travels inside the message's own
        // ratchet-encrypted ciphertext instead. Previously this harness
        // had NO attachment-linking logic here at all, meaning every
        // attachment-related regression test seeded the attachments
        // table directly via SQL and never once drove a real
        // /api/messages POST with an attachmentId the way sendFile()
        // actually does — exactly the gap that let the real bug ship
        // undetected through 175 passing checks.
        if (body.attachmentId) {
          const attachment = db.prepare('SELECT * FROM attachments WHERE id = ?').get(body.attachmentId);
          if (!attachment) return sendJson(res, 404, { error: 'Attachment not found' });
          if (attachment.uploader_id !== auth.userId) return sendJson(res, 403, { error: 'Forbidden' });
          if (attachment.conversation_id !== body.conversationId) return sendJson(res, 403, { error: 'Forbidden' });
          if (attachment.message_id !== null) return sendJson(res, 403, { error: 'Attachment already linked to a message' });
          db.prepare('UPDATE attachments SET message_id = ?, encrypted_dek = ? WHERE id = ?').run(id, body.encryptedDek ?? null, body.attachmentId);
        }

        const delivered = pushToUser(recipientId, {
          type: 'message',
          id,
          conversationId: body.conversationId,
          senderId: auth.userId,
          sequenceNumber,
          ciphertext: body.ciphertext,
          iv: body.iv,
          messageType: body.messageType || 'TEXT',
          replyToMessageId: body.replyToMessageId || null,
          sentAt,
        });
        if (delivered) {
          const now = new Date();
          const data = { delivered_at: now.toISOString() };
          if (convo.disappearing_timer_seconds && convo.disappearing_trigger?.toLowerCase() === 'delivered') {
            data.disappear_at = computeDisappearAt(
              { timerSeconds: convo.disappearing_timer_seconds, trigger: 'delivered', readReceiptsEnabled: true },
              { sentAt: now, deliveredAt: now },
            ).toISOString();
          }
          db.prepare('UPDATE messages SET delivered_at = ?, disappear_at = COALESCE(?, disappear_at) WHERE id = ?').run(
            data.delivered_at,
            data.disappear_at ?? null,
            id,
          );
        }

        return sendJson(res, 201, { id, sequenceNumber, sentAt, delivered });
      }

      if (req.method === 'GET' && path === '/api/messages/sync') {
        const auth = authenticate(req);
        if (!auth) return sendJson(res, 401, { error: 'Unauthorized' });
        const conversationId = url.searchParams.get('conversationId');
        const after = Number(url.searchParams.get('after') || 0);
        // Mirrors messages.service.ts's sync(), which has always called
        // getActiveConversationOrThrow before reading anything — a real
        // gap in this harness (found while adding the burn/re-pair
        // regression suite): without this, sync on a burned or blocked
        // conversation silently returned an empty array with 200 (since
        // burn had already deleted the rows) instead of the 403 the real
        // backend actually returns, which a client needs to tell "there
        // is genuinely nothing new" apart from "this conversation is not
        // currently usable at all."
        const syncConvo = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
        if (!syncConvo || syncConvo.status !== 'ACTIVE') return sendJson(res, 403, { error: 'Conversation not available' });
        if (syncConvo.user_a_id !== auth.userId && syncConvo.user_b_id !== auth.userId) {
          return sendJson(res, 403, { error: 'Conversation not available' });
        }
        // senderId excluded, matching the fix in apps/backend/src/messages/messages.service.ts —
        // sync means "what do I still need to receive," never the caller's own sent messages.
        // Filters/orders on sync_version, not sequence_number: an edit bumps
        // only sync_version, so this is what lets an edit made while the
        // recipient was offline be picked up on their next sync.
        // deleted_at is NOT excluded here — mirrors sync()'s fix: a
        // tombstoned row still needs to reach an offline recipient's
        // next sync (see the DELETE endpoint above and
        // cleanupExpiredMessages, both of which now bump sync_version on
        // delete for exactly this reason), or it would stay cached
        // locally forever with nothing ever correcting it.
        // disappear_at exclusion mirrors sync()'s own defensive filter —
        // a message already past its expiry but NOT YET tombstoned must
        // never be handed out as live content — but once deleted_at IS
        // set (by that same sweep, or an explicit delete), it flows
        // through like any other tombstone rather than being excluded
        // twice over.
        const nowIso = new Date().toISOString();
        const all = db
          .prepare(
            `SELECT * FROM messages
             WHERE conversation_id = ? AND sender_id != ?
               AND (disappear_at IS NULL OR disappear_at > ? OR deleted_at IS NOT NULL)
             ORDER BY sync_version ASC`,
          )
          .all(conversationId, auth.userId, nowIso)
          .map((m) => ({ ...m, sequenceNumber: m.sync_version }));
        const gap = computeSyncGap(after, all);

        const now = new Date().toISOString();
        // Mirrors the real sync()'s fix: a message delivered via sync
        // (recipient was offline at send time) must also start its
        // disappear timer if the trigger is 'delivered' — previously
        // only the immediate-push delivery path computed this at all.
        const deliveredDisappearAt =
          syncConvo.disappearing_timer_seconds && syncConvo.disappearing_trigger?.toLowerCase() === 'delivered'
            ? computeDisappearAt(
                { timerSeconds: syncConvo.disappearing_timer_seconds, trigger: 'delivered', readReceiptsEnabled: true },
                { sentAt: new Date(now), deliveredAt: new Date(now) },
              ).toISOString()
            : null;
        for (const m of gap) {
          // No point marking a tombstone "delivered" — there's nothing
          // left to deliver.
          if (!m.delivered_at && !m.deleted_at) {
            db.prepare('UPDATE messages SET delivered_at = ?, disappear_at = COALESCE(?, disappear_at) WHERE id = ?').run(
              now,
              deliveredDisappearAt,
              m.id,
            );
          }
        }

        return sendJson(
          res,
          200,
          gap.map((m) => ({
            id: m.id,
            senderId: m.sender_id,
            sequenceNumber: m.sync_version,
            // Spelled out explicitly rather than left for the client to
            // infer from "ciphertext happens to be empty" — see
            // sync()'s identical comment.
            deleted: !!m.deleted_at,
            ciphertext: m.ciphertext,
            iv: m.iv,
            messageType: m.message_type,
            replyToMessageId: m.reply_to_message_id,
            sentAt: m.sent_at,
          })),
        );
      }

      if (req.method === 'POST' && path.match(/^\/api\/messages\/[^/]+\/read$/)) {
        const auth = authenticate(req);
        if (!auth) return sendJson(res, 401, { error: 'Unauthorized' });
        const messageId = path.split('/')[3];
        const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
        if (!msg) return sendJson(res, 404, { error: 'Not found' });
        const convo = db.prepare('SELECT * FROM conversations WHERE id = ?').get(msg.conversation_id);
        // The READER's (auth.userId's) own setting — mirrors
        // MessagesService.markRead's fix: this used to be hardcoded to
        // "always tell the sender," so disabling read receipts in
        // Settings had no actual effect.
        const readerSettings = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(auth.userId);
        const readReceiptsEnabled = readerSettings ? !!readerSettings.read_receipts_enabled : true;
        const now = new Date();
        let disappearAt = null;
        if (convo && convo.disappearing_timer_seconds && convo.disappearing_trigger) {
          const trigger = resolveDisappearTrigger({
            timerSeconds: convo.disappearing_timer_seconds,
            trigger: convo.disappearing_trigger.toLowerCase(),
            readReceiptsEnabled,
          });
          if (trigger === 'read') {
            disappearAt = computeDisappearAt(
              { timerSeconds: convo.disappearing_timer_seconds, trigger: 'read', readReceiptsEnabled },
              { sentAt: new Date(msg.sent_at), deliveredAt: msg.delivered_at ? new Date(msg.delivered_at) : null, readAt: now },
            ).toISOString();
          }
        }
        db.prepare('UPDATE messages SET read_at = ?, disappear_at = COALESCE(?, disappear_at) WHERE id = ?').run(
          now.toISOString(),
          disappearAt,
          messageId,
        );
        // readAt is still recorded either way (harmless — server-internal
        // bookkeeping never exposed to the sender directly); only the
        // push — the part that actually tells the sender anything — is
        // gated on the reader's setting.
        if (readReceiptsEnabled) {
          pushToUser(msg.sender_id, { type: 'read_receipt', messageId, conversationId: msg.conversation_id });
        }
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'DELETE' && path.match(/^\/api\/messages\/[^/]+$/)) {
        const auth = authenticate(req);
        if (!auth) return sendJson(res, 401, { error: 'Unauthorized' });
        const messageId = path.split('/')[3];
        const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
        if (!msg || msg.sender_id !== auth.userId) return sendJson(res, 404, { error: 'Message not found' });
        // Mirrors AttachmentsService.deleteForMessage — see its comment
        // for why this needs to be explicit rather than relying on
        // onDelete: Cascade (which never fires for a soft delete).
        db.prepare('DELETE FROM attachments WHERE message_id = ?').run(messageId);
        // Same retry-safe syncVersion bump as PATCH below — mirrors
        // messages.service.ts's deleteMessage(). Bumping this (not just
        // setting deleted_at) is what makes the deletion visible to an
        // offline recipient's next sync — see sync()'s comment on why
        // deleted_at is no longer excluded from its results.
        await retryOnUniqueConflict(() => {
          const maxSeqRow = db
            .prepare('SELECT MAX(sequence_number) as maxSeq, MAX(sync_version) as maxSyncVersion FROM messages WHERE conversation_id = ?')
            .get(msg.conversation_id);
          const syncVersion = Number(nextSequenceNumber(higherCounterValue(maxSeqRow.maxSeq, maxSeqRow.maxSyncVersion)));
          db.prepare("UPDATE messages SET deleted_at = ?, ciphertext = '', iv = '', sync_version = ? WHERE id = ?").run(
            new Date().toISOString(),
            syncVersion,
            messageId,
          );
        }, MAX_SEQUENCE_RETRY_ATTEMPTS);
        const convo = db.prepare('SELECT * FROM conversations WHERE id = ?').get(msg.conversation_id);
        const recipientId = convo.user_a_id === auth.userId ? convo.user_b_id : convo.user_a_id;
        pushToUser(recipientId, { type: 'message_deleted', messageId, conversationId: msg.conversation_id });
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'PATCH' && path.match(/^\/api\/messages\/[^/]+$/)) {
        const auth = authenticate(req);
        if (!auth) return sendJson(res, 401, { error: 'Unauthorized' });
        const messageId = path.split('/')[3];
        const body = await readJsonBody(req);
        const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
        if (!msg || msg.sender_id !== auth.userId) return sendJson(res, 404, { error: 'Message not found' });
        if (msg.deleted_at) return sendJson(res, 400, { error: 'Cannot edit a deleted message' });
        // Same race, same fix, as messages.service.ts's editMessage —
        // see the send() retry loop above for why this can't actually be
        // exercised via genuine concurrency in this harness.
        let syncVersion;
        await retryOnUniqueConflict(() => {
          const maxSeqRow = db
            .prepare('SELECT MAX(sequence_number) as maxSeq, MAX(sync_version) as maxSyncVersion FROM messages WHERE conversation_id = ?')
            .get(msg.conversation_id);
          syncVersion = Number(nextSequenceNumber(higherCounterValue(maxSeqRow.maxSeq, maxSeqRow.maxSyncVersion)));
          db.prepare('UPDATE messages SET ciphertext = ?, iv = ?, edited_at = ?, sync_version = ? WHERE id = ?').run(
            body.ciphertext,
            body.iv,
            new Date().toISOString(),
            syncVersion,
            messageId,
          );
        }, MAX_SEQUENCE_RETRY_ATTEMPTS);
        const convo = db.prepare('SELECT * FROM conversations WHERE id = ?').get(msg.conversation_id);
        const recipientId = convo.user_a_id === auth.userId ? convo.user_b_id : convo.user_a_id;
        pushToUser(recipientId, {
          type: 'message_edited',
          messageId,
          conversationId: msg.conversation_id,
          senderId: auth.userId,
          sequenceNumber: syncVersion,
          ciphertext: body.ciphertext,
          iv: body.iv,
          sentAt: msg.sent_at,
        });
        return sendJson(res, 200, { ok: true });
      }

      // ---- Block / burn ----
      if (req.method === 'POST' && path.match(/^\/api\/conversations\/[^/]+\/block$/)) {
        const auth = authenticate(req);
        if (!auth) return sendJson(res, 401, { error: 'Unauthorized' });
        const conversationId = path.split('/')[3];
        const convo = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
        if (!convo) return sendJson(res, 404, { error: 'Not found' });
        const status = convo.user_a_id === auth.userId ? 'BLOCKED_BY_A' : 'BLOCKED_BY_B';
        db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run(status, conversationId);
        return sendJson(res, 200, { ok: true });
      }

      // Mirrors ConversationsService.unblock exactly, including its
      // ownership check and its core invariant: only the person who
      // initiated the block may lift it — added alongside the F1 fix so
      // that fix's own required regression coverage (a *legitimate*
      // unblock must still allow a normal re-pair) can actually be driven
      // over real HTTP against this harness, the same way every other
      // pairing/conversation scenario in this file is. This endpoint was
      // simply never added to the harness before now — every previous use
      // of "/unblock" in this repo (regression-sync-fix.mjs) called a
      // route that didn't exist and never checked the result.
      if (req.method === 'POST' && path.match(/^\/api\/conversations\/[^/]+\/unblock$/)) {
        const auth = authenticate(req);
        if (!auth) return sendJson(res, 401, { error: 'Unauthorized' });
        const conversationId = path.split('/')[3];
        const convo = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
        if (!convo || (convo.user_a_id !== auth.userId && convo.user_b_id !== auth.userId)) {
          return sendJson(res, 404, { error: 'Not found' });
        }
        const blockedByThisUser =
          (convo.user_a_id === auth.userId && convo.status === 'BLOCKED_BY_A') ||
          (convo.user_b_id === auth.userId && convo.status === 'BLOCKED_BY_B');
        if (!blockedByThisUser) {
          return sendJson(res, 403, { error: 'Only the user who blocked can unblock' });
        }
        db.prepare("UPDATE conversations SET status = 'ACTIVE' WHERE id = ?").run(conversationId);
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'POST' && path.match(/^\/api\/conversations\/[^/]+\/burn$/)) {
        const auth = authenticate(req);
        if (!auth) return sendJson(res, 401, { error: 'Unauthorized' });
        const conversationId = path.split('/')[3];
        const convo = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
        if (!convo || (convo.user_a_id !== auth.userId && convo.user_b_id !== auth.userId)) {
          return sendJson(res, 404, { error: 'Not found' });
        }
        const otherId = convo.user_a_id === auth.userId ? convo.user_b_id : convo.user_a_id;
        // Mirrors ConversationsService.burn: messages, the pending
        // handshake, AND the status flip together. The harness has no
        // real transaction to wrap these in (node:sqlite's DatabaseSync
        // runs every statement here synchronously with no `await`
        // between them, so there is no interleaving window for another
        // request to observe a partial state either way) — what matters
        // for parity with the real fix is that pending_handshakes is
        // actually cleared, which this harness previously did not do at
        // all. Without it, a stale handshake message left over from
        // before the burn could still be fetched and completed after
        // the burn, recreating cryptographic state for a conversation
        // that's supposed to be dead.
        db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId);
        db.prepare('DELETE FROM pending_handshakes WHERE conversation_id = ?').run(conversationId);
        db.prepare("UPDATE conversations SET status = 'DELETED' WHERE id = ?").run(conversationId);
        // The online-peer half of burn propagation — mirrors
        // ConnectionRegistryService.pushToUser in ConversationsService.burn.
        // Best-effort: the offline half (below) is the durable backstop
        // regardless of whether this is delivered.
        pushToUser(otherId, { type: 'conversation_burned', conversationId });
        return sendJson(res, 200, { ok: true });
      }

      // Mirrors ConversationsService.getStatus — deliberately does NOT
      // filter out DELETED (there is no GET /api/conversations list
      // endpoint in this harness to worry about route-ordering against).
      // This is what an offline-during-the-burn peer's client checks on
      // reconnect to learn the conversation is gone, and what any client
      // checks to tell a stale cached session apart from a current one —
      // see ensureFreshSession in app/chat/[conversationId]/page.tsx.
      if (req.method === 'GET' && path.match(/^\/api\/conversations\/[^/]+$/)) {
        const auth = authenticate(req);
        if (!auth) return sendJson(res, 401, { error: 'Unauthorized' });
        const conversationId = path.split('/')[3];
        const convo = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
        if (!convo || (convo.user_a_id !== auth.userId && convo.user_b_id !== auth.userId)) {
          return sendJson(res, 404, { error: 'Not found' });
        }
        return sendJson(res, 200, { id: convo.id, status: convo.status, sessionEpoch: convo.session_epoch });
      }

      if (req.method === 'POST' && path.match(/^\/api\/conversations\/[^/]+\/disappearing$/)) {
        const auth = authenticate(req);
        if (!auth) return sendJson(res, 401, { error: 'Unauthorized' });
        const conversationId = path.split('/')[3];
        const convo = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
        if (!convo || (convo.user_a_id !== auth.userId && convo.user_b_id !== auth.userId)) {
          return sendJson(res, 404, { error: 'Not found' });
        }
        const body = await readJsonBody(req);
        validateShape(body, { trigger: { type: 'enum', values: ['SENT', 'DELIVERED', 'READ'] } });
        db.prepare('UPDATE conversations SET disappearing_timer_seconds = ?, disappearing_trigger = ? WHERE id = ?').run(
          body.timerSeconds ?? null,
          body.timerSeconds ? body.trigger : null,
          conversationId,
        );
        return sendJson(res, 200, { ok: true });
      }

      // ---- Settings ----
      // Mirrors settings.service.ts's get()/update() — auto-creates a
      // default row on first read, same as the real SettingsService.
      // ---- Users (username search) ----
      // Mirrors UsersController.search -> UsersService.searchByUsername:
      // exact match, requester's own account short-circuits to isSelf,
      // target's usernameSearchEnabled gates visibility, and an existing
      // blocked conversation (either direction) suppresses the result —
      // same generic `{ user: null }` for "doesn't exist", "opted out",
      // and "blocked", so none of those three cases is distinguishable
      // from the others.
      if (req.method === 'GET' && path === '/api/users/search') {
        const auth = authenticate(req);
        if (!auth) return sendJson(res, 401, { error: 'Unauthorized' });
        const username = normalizeUsername(url.searchParams.get('username') ?? '');
        const usernameCheck = validateUsername(username);
        if (!usernameCheck.valid) throw new ShapeValidationError(usernameCheck.error ?? 'Invalid username');

        const target = db.prepare('SELECT id, username, display_name, status FROM users WHERE username = ?').get(username);
        if (!target || target.status !== 'ACTIVE') return sendJson(res, 200, { user: null });

        if (target.id === auth.userId) {
          return sendJson(res, 200, { user: { username: target.username, displayName: target.display_name }, isSelf: true });
        }

        const settingsRow = db.prepare('SELECT username_search_enabled FROM user_settings WHERE user_id = ?').get(target.id);
        const discoverable = settingsRow ? !!settingsRow.username_search_enabled : true;
        if (!discoverable) return sendJson(res, 200, { user: null });

        const [userAId, userBId] = auth.userId < target.id ? [auth.userId, target.id] : [target.id, auth.userId];
        const conversation = db
          .prepare('SELECT status FROM conversations WHERE user_a_id = ? AND user_b_id = ?')
          .get(userAId, userBId);
        if (conversation && (conversation.status === 'BLOCKED_BY_A' || conversation.status === 'BLOCKED_BY_B')) {
          return sendJson(res, 200, { user: null });
        }

        return sendJson(res, 200, { user: { username: target.username, displayName: target.display_name } });
      }

      if (req.method === 'GET' && path === '/api/settings') {
        const auth = authenticate(req);
        if (!auth) return sendJson(res, 401, { error: 'Unauthorized' });
        let row = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(auth.userId);
        if (!row) {
          db.prepare('INSERT INTO user_settings (user_id) VALUES (?)').run(auth.userId);
          row = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(auth.userId);
        }
        return sendJson(res, 200, {
          readReceiptsEnabled: !!row.read_receipts_enabled,
          typingIndicatorEnabled: !!row.typing_indicator_enabled,
          usernameSearchEnabled: !!row.username_search_enabled,
          attachmentStorageProvider: row.attachment_storage_provider || 'MANAGED',
        });
      }
      if (req.method === 'PATCH' && path === '/api/settings') {
        const auth = authenticate(req);
        if (!auth) return sendJson(res, 401, { error: 'Unauthorized' });
        const body = await readJsonBody(req);
        if (!db.prepare('SELECT 1 FROM user_settings WHERE user_id = ?').get(auth.userId)) {
          db.prepare('INSERT INTO user_settings (user_id) VALUES (?)').run(auth.userId);
        }
        if (body.readReceiptsEnabled !== undefined) {
          db.prepare('UPDATE user_settings SET read_receipts_enabled = ? WHERE user_id = ?').run(body.readReceiptsEnabled ? 1 : 0, auth.userId);
        }
        if (body.typingIndicatorEnabled !== undefined) {
          db.prepare('UPDATE user_settings SET typing_indicator_enabled = ? WHERE user_id = ?').run(body.typingIndicatorEnabled ? 1 : 0, auth.userId);
        }
        if (body.usernameSearchEnabled !== undefined) {
          db.prepare('UPDATE user_settings SET username_search_enabled = ? WHERE user_id = ?').run(body.usernameSearchEnabled ? 1 : 0, auth.userId);
        }
        if (body.attachmentStorageProvider !== undefined) {
          db.prepare('UPDATE user_settings SET attachment_storage_provider = ? WHERE user_id = ?').run(body.attachmentStorageProvider, auth.userId);
        }
        const row = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(auth.userId);
        return sendJson(res, 200, {
          readReceiptsEnabled: !!row.read_receipts_enabled,
          typingIndicatorEnabled: !!row.typing_indicator_enabled,
          usernameSearchEnabled: !!row.username_search_enabled,
          attachmentStorageProvider: row.attachment_storage_provider || 'MANAGED',
        });
      }

      // ---- Google Drive Storage ----
      if (req.method === 'GET' && path === '/api/storage/google-drive/status') {
        const auth = authenticate(req);
        if (!auth) return sendJson(res, 401, { error: 'Unauthorized' });
        const conn = db.prepare('SELECT * FROM google_drive_connections WHERE user_id = ?').get(auth.userId);
        const settings = db.prepare('SELECT attachment_storage_provider FROM user_settings WHERE user_id = ?').get(auth.userId);
        const connected = !!(conn && !conn.revoked_at);
        return sendJson(res, 200, {
          configured: true,
          connected,
          revoked: !!(conn && conn.revoked_at),
          folderId: conn?.drive_folder_id || null,
          folderUrl: conn?.drive_folder_id ? `https://drive.google.com/drive/folders/${conn.drive_folder_id}` : null,
          provider: settings?.attachment_storage_provider || 'MANAGED',
        });
      }

      if (req.method === 'GET' && path === '/api/storage/google-drive/connect-url') {
        const auth = authenticate(req);
        if (!auth) return sendJson(res, 401, { error: 'Unauthorized' });
        return sendJson(res, 200, {
          authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=mock&response_type=code',
        });
      }

      if (req.method === 'POST' && path === '/api/storage/google-drive/disconnect') {
        const auth = authenticate(req);
        if (!auth) return sendJson(res, 401, { error: 'Unauthorized' });
        db.prepare('DELETE FROM google_drive_connections WHERE user_id = ?').run(auth.userId);
        db.prepare('INSERT OR REPLACE INTO user_settings (user_id, attachment_storage_provider) VALUES (?, ?)').run(auth.userId, 'MANAGED');
        return sendJson(res, 200, { ok: true });
      }

      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      if (err instanceof ShapeValidationError) {
        // Mirrors a NestJS ValidationPipe rejection — see validateShape's comment.
        return sendJson(res, 400, { error: err.message });
      }
      // Never leak internals to the client — see docs on error handling.
      console.error('[harness] internal error:', err);
      return sendJson(res, 500, { error: 'Internal error' });
    }
  }

  function findOrCreateDeviceRow(userId, body) {
    const existing = db
      .prepare('SELECT id, identity_dh_public as identityDhPublic, identity_signing_public as identitySigningPublic FROM devices WHERE user_id = ?')
      .all(userId);
    const match = findMatchingDevice(existing, { identityDhPublic: body.identityDhPublic, identitySigningPublic: body.identitySigningPublic });
    const now = new Date().toISOString();

    if (match) {
      db.prepare(
        `UPDATE devices SET device_name = ?, platform = ?, signed_prekey_public = ?, signed_prekey_signature = ?, last_seen_at = ?, revoked_at = NULL WHERE id = ?`,
      ).run(body.deviceName || null, body.platform || 'web', body.signedPrekeyPublic, body.signedPrekeySignature, now, match.id);
      for (const pub of body.oneTimePrekeysPublic || []) {
        db.prepare('INSERT INTO one_time_prekeys (id, device_id, public_key) VALUES (?, ?, ?)').run(randomUUID(), match.id, pub);
      }
      return { deviceId: match.id, isNewDevice: false };
    }

    const deviceId = randomUUID();
    db.prepare(
      `INSERT INTO devices (id, user_id, device_name, platform, identity_dh_public, identity_signing_public, signed_prekey_public, signed_prekey_signature, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      deviceId,
      userId,
      body.deviceName || null,
      body.platform || 'web',
      body.identityDhPublic,
      body.identitySigningPublic,
      body.signedPrekeyPublic,
      body.signedPrekeySignature,
      now,
    );
    for (const pub of body.oneTimePrekeysPublic || []) {
      db.prepare('INSERT INTO one_time_prekeys (id, device_id, public_key) VALUES (?, ?, ?)').run(randomUUID(), deviceId, pub);
    }
    return { deviceId, isNewDevice: true };
  }

  function issueSession(userId, deviceId, ctx) {
    const accessToken = issueAccessToken({ userId, deviceId }, ACCESS_TOKEN_SECRET);
    const refreshToken = generateRefreshToken();
    db.prepare(
      'INSERT INTO auth_sessions (id, user_id, device_id, refresh_token_hash, user_agent, ip_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      randomUUID(),
      userId,
      deviceId,
      hashRefreshToken(refreshToken),
      ctx?.userAgent ?? null,
      ctx?.ip ? hashIp(ctx.ip) : null,
      new Date().toISOString(),
      new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString(),
    );
    return { accessToken, refreshToken };
  }

  /** Mirrors auth.service.ts's revokeSessionAndDisconnect. */
  function revokeSessionAndDisconnect(sessionId, deviceId) {
    const now = new Date().toISOString();
    db.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE id = ?').run(now, sessionId);
    db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(now, deviceId);
    pushToDevice(deviceId, { type: 'session_revoked', reason: 'revoked_by_user' });
    setTimeout(() => disconnectDevice(deviceId), 250);
  }

  const server = createServer((req, res) => {
    handleRequest(req, res);
  });

  attachWebSocketServer(server, (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const auth = verifyAccessToken(url.searchParams.get('token') || '', ACCESS_TOKEN_SECRET);
    if (!auth) {
      ws.close();
      return;
    }
    // A cryptographically valid, unexpired token from a revoked device
    // must still be rejected — mirrors RealtimeGateway.handleConnection's
    // new check. Without this, "log out this device" wouldn't actually
    // stop a reconnect using the same still-unexpired token.
    const device = db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(auth.deviceId);
    if (!device || device.revoked_at) {
      ws.close();
      return;
    }
    if (!liveConnections.has(auth.userId)) liveConnections.set(auth.userId, new Set());
    const existing = liveConnections.get(auth.userId);
    if (existing.size >= MAX_SOCKETS_PER_USER) {
      ws.close();
      return;
    }
    existing.add(ws);
    if (!deviceConnections.has(auth.deviceId)) deviceConnections.set(auth.deviceId, new Set());
    deviceConnections.get(auth.deviceId).add(ws);
    db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), auth.deviceId);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.type === 'typing') {
        if (!allowTyping(auth.userId)) return; // rate-limited — silently dropped, same as onTyping's guard
        // The typer's (auth.userId's) own setting — mirrors
        // RealtimeGateway.onTyping's fix: this was previously relayed
        // unconditionally, so disabling this in Settings had no effect.
        const settings = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(auth.userId);
        if (settings && !settings.typing_indicator_enabled) return;
        const convo = db.prepare('SELECT * FROM conversations WHERE id = ?').get(msg.conversationId);
        if (!convo) return;
        const otherId = convo.user_a_id === auth.userId ? convo.user_b_id : convo.user_a_id;
        // Never persisted — typing state is transient by design.
        pushToUser(otherId, { type: 'typing', conversationId: msg.conversationId, isTyping: !!msg.isTyping, from: auth.userId });
      }
    });

    ws.on('close', () => {
      liveConnections.get(auth.userId)?.delete(ws);
      deviceConnections.get(auth.deviceId)?.delete(ws);
      if (!isDeviceOnline(auth.deviceId)) {
        db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), auth.deviceId);
      }
    });
  });

  /**
   * Mirrors MessagesService.cleanupExpiredMessages — exposed here as a
   * directly callable function (rather than only firing on its own
   * setInterval, which is also wired below for parity) specifically so
   * tests can invoke it deterministically instead of waiting on real
   * wall-clock time to pass.
   */
  function cleanupExpiredMessages() {
    const now = new Date().toISOString();
    const expired = db
      .prepare('SELECT id, conversation_id, sender_id FROM messages WHERE disappear_at IS NOT NULL AND disappear_at <= ? AND deleted_at IS NULL ORDER BY sync_version ASC')
      .all(now);
    if (expired.length === 0) return 0;
    const byConversation = new Map();
    for (const m of expired) {
      const list = byConversation.get(m.conversation_id) ?? [];
      list.push(m.id);
      byConversation.set(m.conversation_id, list);
    }
    for (const [conversationId, messageIds] of byConversation) {
      const convo = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
      if (!convo) continue;
      for (const messageId of messageIds) {
        // Same reasoning as the DELETE endpoint above.
        db.prepare('DELETE FROM attachments WHERE message_id = ?').run(messageId);
        // Bumping sync_version (not just deleted_at) mirrors
        // messages.service.ts's identical fix — see its comment for why
        // an offline recipient otherwise never learns about this at all.
        const maxSeqRow = db
          .prepare('SELECT MAX(sequence_number) as maxSeq, MAX(sync_version) as maxSyncVersion FROM messages WHERE conversation_id = ?')
          .get(conversationId);
        const syncVersion = Number(nextSequenceNumber(higherCounterValue(maxSeqRow.maxSeq, maxSeqRow.maxSyncVersion)));
        db.prepare("UPDATE messages SET deleted_at = ?, ciphertext = '', iv = '', sync_version = ? WHERE id = ?").run(now, syncVersion, messageId);
        pushToUser(convo.user_a_id, { type: 'message_deleted', messageId, conversationId });
        pushToUser(convo.user_b_id, { type: 'message_deleted', messageId, conversationId });
      }
    }
    return expired.length;
  }
  const expirySweepTimer = setInterval(cleanupExpiredMessages, EXPIRY_SWEEP_INTERVAL_MS);
  expirySweepTimer.unref?.();
  server.on('close', () => clearInterval(expirySweepTimer));

  /**
   * Mirrors AttachmentsService.cleanupOrphanedAttachments (THE FIX for
   * the orphaned-upload gap found in this audit pass — see that
   * method's own comment). Exposed the same way cleanupExpiredMessages
   * is: directly callable so a test can invoke it deterministically
   * instead of waiting on the real interval or real wall-clock time.
   * Deletion is one row at a time, scoped to `id` AND `message_id IS
   * NULL` together — same race-safety reasoning as the real method:
   * an attachment that gets linked to a message between the SELECT and
   * this DELETE must survive.
   */
  function cleanupOrphanedAttachments() {
    const cutoff = new Date(Date.now() - ORPHANED_ATTACHMENT_MAX_AGE_MS).toISOString();
    const orphaned = db.prepare('SELECT id, drive_file_id FROM attachments WHERE message_id IS NULL AND uploaded_at <= ?').all(cutoff);
    for (const a of orphaned) {
      db.prepare('DELETE FROM attachments WHERE id = ? AND message_id IS NULL').run(a.id);
    }
    return orphaned.length;
  }
  const orphanSweepTimer = setInterval(cleanupOrphanedAttachments, ORPHAN_SWEEP_INTERVAL_MS);
  orphanSweepTimer.unref?.();
  server.on('close', () => clearInterval(orphanSweepTimer));

  return { server, db, cleanupExpiredMessages, cleanupOrphanedAttachments };
}

// Allow running this file directly: `node server.mjs`
if (import.meta.url === `file://${process.argv[1]}`) {
  const { server } = createHarness();
  const port = process.env.PORT || 4100;
  server.listen(port, () => console.log(`Verification harness listening on :${port}`));
}
