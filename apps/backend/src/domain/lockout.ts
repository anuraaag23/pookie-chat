/**
 * Login attempt lockout — escalating delay rather than pairing codes'
 * "permanently dead, must regenerate" rule, because an account is not a
 * disposable secret the way a pairing code is: locking it out for good
 * after a handful of mistyped passwords would be a self-inflicted denial
 * of service. Escalating, time-bound lockout balances the two concerns.
 */
export interface LoginAttemptState {
  failedLoginCount: number;
  lockedUntil: Date | null;
}

const LOCKOUT_THRESHOLD = 5;
const BASE_LOCKOUT_SECONDS = 30;

export function isLoginLocked(state: LoginAttemptState, now: Date = new Date()): boolean {
  return state.lockedUntil !== null && now.getTime() < state.lockedUntil.getTime();
}

/** Doubles the lockout window each time the threshold is hit again, capped at 24h, so repeated automated guessing gets progressively more expensive. */
export function recordFailedLogin(state: LoginAttemptState, now: Date = new Date()): LoginAttemptState {
  const failedLoginCount = state.failedLoginCount + 1;
  if (failedLoginCount < LOCKOUT_THRESHOLD) {
    return { failedLoginCount, lockedUntil: state.lockedUntil };
  }
  const timesOverThreshold = failedLoginCount - LOCKOUT_THRESHOLD + 1;
  const lockoutSeconds = Math.min(BASE_LOCKOUT_SECONDS * 2 ** (timesOverThreshold - 1), 24 * 60 * 60);
  return { failedLoginCount, lockedUntil: new Date(now.getTime() + lockoutSeconds * 1000) };
}

export function clearLoginLockout(): LoginAttemptState {
  return { failedLoginCount: 0, lockedUntil: null };
}
