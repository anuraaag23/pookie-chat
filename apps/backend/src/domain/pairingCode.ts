/**
 * 6-digit pairing code generation and verification.
 *
 * The code itself is never stored anywhere — only an HMAC of it, keyed
 * with a server-side pepper (an env secret, never in the database). A
 * full database dump does not let an attacker enumerate or brute-force
 * codes offline without also having the pepper. Server-side rate
 * limiting (enforced in the NestJS controller, not here) is still the
 * primary defense — see docs/01-THREAT-MODEL.md §5 on why "Forever"
 * codes are riskier even with this in place.
 */
import { randomInt, createHmac, timingSafeEqual } from 'node:crypto';

export function generatePairingCode(): string {
  const n = randomInt(0, 1_000_000); // CSPRNG, uniform over [0, 1000000)
  return n.toString().padStart(6, '0');
}

export function hashPairingCode(code: string, pepper: string): string {
  return createHmac('sha256', pepper).update(code).digest('base64');
}

/** Constant-time comparison — deliberately not `===`, which leaks timing information about how many leading bytes matched. */
export function verifyPairingCode(code: string, pepper: string, storedHmac: string): boolean {
  const candidate = Buffer.from(hashPairingCode(code, pepper), 'base64');
  const expected = Buffer.from(storedHmac, 'base64');
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

export interface PairingDurationOption {
  label: string;
  seconds: number | null; // null = "Forever"
}

// Matches the brief's required set exactly. "Forever" is included per the
// requirement, but the UI (PairingScreen) does not default to it and shows
// a warning when it's selected — see docs/01-THREAT-MODEL.md §5.
export const PAIRING_DURATION_OPTIONS: readonly PairingDurationOption[] = [
  { label: '5 minutes', seconds: 5 * 60 },
  { label: '15 minutes', seconds: 15 * 60 },
  { label: '30 minutes', seconds: 30 * 60 },
  { label: '1 hour', seconds: 60 * 60 },
  { label: '6 hours', seconds: 6 * 60 * 60 },
  { label: '12 hours', seconds: 12 * 60 * 60 },
  { label: '1 day', seconds: 24 * 60 * 60 },
  { label: '7 days', seconds: 7 * 24 * 60 * 60 },
  { label: 'Forever', seconds: null },
];

export function computeExpiresAt(seconds: number | null, now: Date = new Date()): Date | null {
  if (seconds === null) return null;
  return new Date(now.getTime() + seconds * 1000);
}

export function isExpired(expiresAt: Date | null, now: Date = new Date()): boolean {
  if (expiresAt === null) return false;
  return now.getTime() >= expiresAt.getTime();
}

// ---------------------------------------------------------------------------
// Rate limiting / lockout state machine — pure logic, no framework or DB
// dependency, so the actual lockout rules are unit-testable in isolation.
// ---------------------------------------------------------------------------

export interface PairingAttemptState {
  failedAttempts: number;
  lockedUntil: Date | null;
}

const MAX_ATTEMPTS_BEFORE_LOCKOUT = 5;

export function isLockedOut(state: PairingAttemptState, now: Date = new Date()): boolean {
  return state.lockedUntil !== null && now.getTime() < state.lockedUntil.getTime();
}

/** A code is permanently invalidated (not just time-locked) after too many wrong guesses — it must be regenerated, not just waited out. */
export function recordFailedAttempt(state: PairingAttemptState): PairingAttemptState & { mustRegenerate: boolean } {
  const failedAttempts = state.failedAttempts + 1;
  const mustRegenerate = failedAttempts >= MAX_ATTEMPTS_BEFORE_LOCKOUT;
  return {
    failedAttempts,
    lockedUntil: mustRegenerate ? new Date(8640000000000000) : state.lockedUntil, // far future = effectively permanent until regenerated
    mustRegenerate,
  };
}
