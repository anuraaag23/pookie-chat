import { registerDecorator } from 'class-validator';
import type { ValidationOptions } from 'class-validator';

/**
 * Canonical username policy — the one place these rules live on the
 * backend. RegisterDto's @IsUsername(), the username-availability
 * endpoint, and the username-search endpoint all validate through this
 * file rather than each re-implementing the rules, so there is exactly
 * one definition of "valid username" for the server to disagree with
 * itself about.
 *
 * Mirrored (not shared via import — this is a two-workspace npm
 * monorepo with no shared `packages/*` yet, so a real shared package
 * would be a bigger structural change than this feature calls for) on
 * the frontend at apps/web/lib/username.ts purely for instant
 * client-side feedback. That copy is UX only; this file is what's
 * actually authoritative — every one of these checks is re-run
 * server-side regardless of what the client already validated.
 *
 * Rules:
 *  - 3-30 characters
 *  - lowercase storage; letters a-z, digits 0-9, underscore only
 *  - must start with a letter
 *  - must end with a letter or digit — never an underscore
 *  - no consecutive underscores
 *  - no "@", no spaces, no other punctuation
 *  - case-insensitive uniqueness is achieved by only ever storing the
 *    already-lowercased form (see normalizeUsername below), so a plain
 *    DB unique constraint on the column is sufficient — no functional/
 *    expression index is needed (see the migration that adds this
 *    column).
 */
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 30;

// [a-z] to start, then any run of [a-z0-9], optionally followed by more
// "_[a-z0-9]+" groups. This shape is what makes a leading, trailing, or
// doubled underscore structurally unrepresentable, rather than something
// checked for as a separate rule.
const USERNAME_SHAPE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

export interface UsernameValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * trim + lowercase ONLY. Deliberately does not strip "@", spaces, or any
 * other character — an invalid character must be rejected by
 * validateUsername, never silently dropped, so a normalized-then-stored
 * value is never something the person didn't actually type (modulo case
 * and surrounding whitespace, which the spec explicitly allows
 * normalizing).
 */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Validates an ALREADY-NORMALIZED username (call normalizeUsername
 * first, or pass raw input through — validation itself doesn't
 * normalize, so callers control exactly what gets checked vs. stored).
 * Checks are ordered so the first failure reported is the most specific,
 * useful one rather than always falling through to the generic
 * character-class message.
 */
export function validateUsername(value: string): UsernameValidationResult {
  if (value.length < USERNAME_MIN_LENGTH || value.length > USERNAME_MAX_LENGTH) {
    return { valid: false, error: `Username must be ${USERNAME_MIN_LENGTH}\u201330 characters` };
  }
  if (value.includes('@')) {
    return { valid: false, error: 'Username cannot contain "@"' };
  }
  if (/\s/.test(value)) {
    return { valid: false, error: 'Username cannot contain spaces' };
  }
  if (!/^[a-z]/.test(value)) {
    return { valid: false, error: 'Username must start with a letter' };
  }
  if (!/[a-z0-9]$/.test(value)) {
    return { valid: false, error: 'Username must end with a letter or number' };
  }
  if (value.includes('__')) {
    return { valid: false, error: 'Username cannot contain consecutive underscores' };
  }
  if (!USERNAME_SHAPE.test(value)) {
    return { valid: false, error: 'Username can contain only letters, numbers, and underscores' };
  }
  return { valid: true };
}

/**
 * class-validator decorator backed by validateUsername above. Expects to
 * run AFTER a normalizing @Transform (trim + lowercase) on the same
 * field — see RegisterDto and SearchUsernameDto — so what this actually
 * checks is the value about to be stored/queried, not raw user input.
 */
export function IsUsername(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isUsername',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'string' && validateUsername(value).valid;
        },
        defaultMessage(args): string {
          const value = args?.value;
          if (typeof value !== 'string' || value.length === 0) return 'Username is required';
          return validateUsername(value).error ?? 'Invalid username';
        },
      },
    });
  };
}

/**
 * Username change cooldown policy: once per 90 days. A single constant
 * here — rather than a magic "90" typed separately into AuthService and
 * the frontend — is what lets the frontend's displayed cooldown date and
 * the backend's actual enforcement never quietly drift apart.
 */
export const USERNAME_CHANGE_COOLDOWN_DAYS = 90;
const USERNAME_CHANGE_COOLDOWN_MS = USERNAME_CHANGE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

/**
 * null in, null out: "never changed" means "no cooldown, can change
 * right now." A non-null usernameChangedAt maps to the moment the
 * cooldown lifts, which may already be in the past.
 */
export function nextUsernameChangeAllowedAt(usernameChangedAt: Date | null): Date | null {
  if (!usernameChangedAt) return null;
  return new Date(usernameChangedAt.getTime() + USERNAME_CHANGE_COOLDOWN_MS);
}

export function isUsernameChangeCoolingDown(usernameChangedAt: Date | null, now: Date = new Date()): boolean {
  const nextAllowed = nextUsernameChangeAllowedAt(usernameChangedAt);
  return nextAllowed !== null && nextAllowed > now;
}
