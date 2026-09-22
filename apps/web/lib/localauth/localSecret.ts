/**
 * Client-side-only secret verification: the hidden-chat unlock code and
 * the app-lock PIN. This never touches the server — see
 * docs/02-DATABASE-SCHEMA.md on why hidden-chat state is local-only.
 *
 * Uses PBKDF2 via the native Web Crypto API, not scrypt/Argon2id: neither
 * is part of the Web Crypto standard, so browsers don't expose them, and
 * no npm package could be added in this sandbox to fill the gap. PBKDF2-
 * HMAC-SHA256 at a high iteration count is still a legitimate, standard,
 * zero-dependency choice — the honest trade-off is that it isn't
 * memory-hard the way scrypt/Argon2id are. That matters more here than
 * for account passwords, because (per docs/01-THREAT-MODEL.md §5) this
 * secret has no server able to rate-limit guesses against it — which is
 * also why the settings UI for this should encourage a longer secret than
 * a bare 4-digit PIN.
 */

const PBKDF2_ITERATIONS = 600_000; // current OWASP-recommended floor for PBKDF2-HMAC-SHA256
const KEY_LENGTH_BITS = 256;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Same BufferSource/ArrayBufferLike narrowing as lib/crypto/engine.ts's
 * `bs()` helper — see that file's comment for why this cast is safe.
 */
function bs(u: Uint8Array): BufferSource {
  return u as unknown as BufferSource;
}

async function deriveBits(secret: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    bs(new TextEncoder().encode(secret.normalize('NFKC'))),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: bs(salt), iterations, hash: 'SHA-256' },
    keyMaterial,
    KEY_LENGTH_BITS,
  );
  return new Uint8Array(bits);
}

export async function hashLocalSecret(secret: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await deriveBits(secret, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(derived)}`;
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Always performs a real PBKDF2 computation, even when `storedVerifier`
 * is null (hidden chat not configured on this device) — so a plain,
 * ordinary search costs exactly as much CPU time as a wrong unlock
 * attempt. This is what stops response timing from ever revealing that
 * hidden-chat functionality exists at all.
 */
export async function checkLocalSecret(input: string, storedVerifier: string | null): Promise<boolean> {
  const DUMMY = `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToBase64(new Uint8Array(16))}$${bytesToBase64(new Uint8Array(32))}`;
  const verifierToCheck = storedVerifier ?? DUMMY;
  const parts = verifierToCheck.split('$');
  if (parts.length !== 4) return false;
  const [, iterStr, saltB64, hashB64] = parts as [string, string, string, string];
  const iterations = Number(iterStr);
  const salt = base64ToBytes(saltB64);
  const expected = base64ToBytes(hashB64);

  const derived = await deriveBits(input, salt, iterations);
  const matches = timingSafeEqualBytes(derived, expected);
  // Only report success if there really was a verifier to match — the
  // dummy path above exists purely to burn identical CPU time.
  return storedVerifier !== null && matches;
}
