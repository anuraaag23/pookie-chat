import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { registerDecorator } from 'class-validator';
import type { ValidationOptions } from 'class-validator';

/**
 * Canonical email normalization — trim + lowercase ONLY.
 * Deliberately preserves dots, plus-tags, and provider-specific representations.
 * The server must never treat different provider aliases as equivalent.
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** RFC 5321 maximum total length for an email address is 254 characters. */
export const EMAIL_MAX_LENGTH = 254;
export const EMAIL_MIN_LENGTH = 5; // e.g. a@b.c

// Practical standards-compatible email regex: local-part @ domain.tld
// Disallows spaces, multiple @, and ensures reasonable domain syntax.
const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

export interface EmailValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates a normalized email address.
 */
export function validateEmail(value: string): EmailValidationResult {
  if (!value || typeof value !== 'string') {
    return { valid: false, error: 'Email is required' };
  }
  const trimmed = value.trim();
  if (trimmed.length < EMAIL_MIN_LENGTH || trimmed.length > EMAIL_MAX_LENGTH) {
    return { valid: false, error: `Email must be between ${EMAIL_MIN_LENGTH} and ${EMAIL_MAX_LENGTH} characters` };
  }
  if (/\s/.test(trimmed)) {
    return { valid: false, error: 'Email cannot contain spaces' };
  }
  const atCount = (trimmed.match(/@/g) || []).length;
  if (atCount !== 1) {
    return { valid: false, error: 'Email must contain exactly one "@"' };
  }
  const [localPart, domainPart] = trimmed.split('@');
  if (!localPart || !domainPart) {
    return { valid: false, error: 'Invalid email format' };
  }
  if (localPart.startsWith('.') || localPart.endsWith('.') || localPart.includes('..')) {
    return { valid: false, error: 'Email username cannot start, end, or contain consecutive dots' };
  }
  if (!EMAIL_REGEX.test(trimmed)) {
    return { valid: false, error: 'Please enter a valid email address' };
  }
  return { valid: true };
}

/**
 * class-validator decorator backed by validateEmail.
 */
export function IsEmailAddress(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isEmailAddress',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'string' && validateEmail(value).valid;
        },
        defaultMessage(args): string {
          const value = args?.value;
          if (typeof value !== 'string' || value.length === 0) return 'Email is required';
          return validateEmail(value).error ?? 'Invalid email address';
        },
      },
    });
  };
}

/**
 * Generates a cryptographically strong 6-digit numeric verification code.
 */
export function generateVerificationCode(): string {
  return randomInt(100000, 1000000).toString();
}

/**
 * Hashes a verification code using SHA-256 for secure storage in the database.
 * Raw codes are NEVER stored long-term in the database.
 */
export function hashVerificationCode(code: string): string {
  return createHash('sha256').update(code.trim()).digest('hex');
}

/**
 * Timing-safe comparison of verification code hash.
 */
export function verifyVerificationCode(inputCode: string, storedHash: string): boolean {
  const inputHash = hashVerificationCode(inputCode);
  const inputBuf = Buffer.from(inputHash, 'hex');
  const storedBuf = Buffer.from(storedHash, 'hex');
  if (inputBuf.length !== storedBuf.length) return false;
  return timingSafeEqual(inputBuf, storedBuf);
}
