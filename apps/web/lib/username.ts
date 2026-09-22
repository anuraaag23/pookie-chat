/**
 * Client-side mirror of apps/backend/src/domain/username.ts's canonical
 * username policy — for instant, no-round-trip feedback in the
 * registration and search forms ONLY. This is UX, not the security
 * boundary: every one of these checks is re-run server-side regardless
 * of what this file says, and a mismatch here can at worst produce a
 * confusing error message, never let an invalid username through (the
 * backend DTO validation and DB unique constraint are what actually
 * enforce the policy).
 *
 * Kept deliberately in sync with the backend copy by hand (this is a
 * two-workspace npm monorepo with no shared `packages/*` yet — see that
 * file's own header comment for why introducing one wasn't done just
 * for this).
 */
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 30;

const USERNAME_SHAPE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

export interface UsernameValidationResult {
  valid: boolean;
  error?: string;
}

/** trim + lowercase only — never strips "@" or spaces; those must fail validateUsername instead, same reasoning as the backend copy. */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export function validateUsername(value: string): UsernameValidationResult {
  if (value.length === 0) {
    return { valid: false, error: 'Username is required' };
  }
  if (value.length < USERNAME_MIN_LENGTH || value.length > USERNAME_MAX_LENGTH) {
    return { valid: false, error: `Username must be ${USERNAME_MIN_LENGTH}\u201330 characters` };
  }
  if (value.includes('@')) {
    return { valid: false, error: 'Username can\u2019t contain "@"' };
  }
  if (/\s/.test(value)) {
    return { valid: false, error: 'Username can\u2019t contain spaces' };
  }
  if (!/^[a-z]/.test(value)) {
    return { valid: false, error: 'Username must start with a letter' };
  }
  if (!/[a-z0-9]$/.test(value)) {
    return { valid: false, error: 'Username must end with a letter or number' };
  }
  if (value.includes('__')) {
    return { valid: false, error: 'Username can\u2019t contain consecutive underscores' };
  }
  if (!USERNAME_SHAPE.test(value)) {
    return { valid: false, error: 'Username can contain only letters, numbers, and underscores' };
  }
  return { valid: true };
}
