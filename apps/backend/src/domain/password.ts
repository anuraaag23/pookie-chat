/**
 * Account password hashing.
 *
 * Uses Node's built-in `scrypt` rather than Argon2id. Argon2id needs the
 * `argon2` package's native addon, which has to be compiled or downloaded —
 * not possible in a sandbox with no network access, so it was never
 * actually installable or testable here. scrypt (RFC 7914) is also a
 * memory-hard, OWASP-acceptable password hashing algorithm, and it ships
 * in Node's standard library with zero external dependencies. Swapping to
 * argon2 later, once deployed somewhere `npm install` actually works, is a
 * localized change to this one file — nothing else depends on which
 * algorithm is used, only on `hashPassword`/`verifyPassword`'s behavior.
 *
 * Never logs, returns, or stores the plaintext password. The parameters
 * used to hash a given password are stored alongside its hash so they can
 * be strengthened later without invalidating existing accounts.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

interface ScryptOptions {
  N: number;
  r: number;
  p: number;
  maxmem: number;
}

// A hand-written wrapper instead of util.promisify(scryptCallback): scrypt
// has multiple overloads (with/without an options object), and promisify's
// typings don't reliably resolve to the 4-argument-plus-options one across
// @types/node versions — this sandbox has never had the project's pinned
// @types/node available to confirm which way that resolves. Calling the
// callback form directly with all four arguments is unambiguous and needs
// no type assertion on the result, since the callback's own type already
// says `derivedKey: Buffer`.
function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

// scrypt cost parameters. N=2^15 costs ~128MB of memory (128 * N * r bytes)
// and lands well under a second on typical hardware — see the accompanying
// test file for this sandbox's measured timing. maxmem is raised
// explicitly because Node's default (32MB) is too small for N=2^15 at r=8.
const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const MAX_MEM = 256 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derivedKey = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAX_MEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${derivedKey.toString('base64')}`;
}

/** Constant-time comparison against the stored hash — never uses `===` on the derived key. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  // Runtime-safe: the length check above guarantees exactly 6 elements;
  // TS can't infer that from a plain string[] destructure on its own.
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const n = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  if (expected.length === 0) return false;

  const derivedKey = await scrypt(password.normalize('NFKC'), salt, expected.length, {
    N: n,
    r,
    p,
    maxmem: MAX_MEM,
  });

  if (derivedKey.length !== expected.length) return false;
  return timingSafeEqual(derivedKey, expected);
}
