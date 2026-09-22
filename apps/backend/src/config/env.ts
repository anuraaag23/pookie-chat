/**
 * Reads required configuration from the environment and fails fast at
 * boot if something security-critical is missing, rather than letting the
 * app start with e.g. `undefined` as a JWT secret.
 */
export interface AppConfig {
  port: number;
  webOrigin: string;
  databaseUrl: string;
  accessTokenSecret: string;
  refreshTokenSecret: string; // reserved for future refresh-token signing needs beyond the opaque-token model
  pairingCodePepper: string;
  googleDriveSharedDriveId: string | null;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. Copy .env.example to .env and fill in real values before starting the server.`,
    );
  }
  return value;
}

// .env.example's own placeholder text, verbatim — present here so a
// deployment that copied the file but forgot to actually replace a
// value fails loudly at boot instead of silently running with a secret
// an attacker can read directly out of version control or public
// documentation. Checked case-insensitively-ish (exact match is enough:
// these are fixed strings, not a pattern a real generated secret could
// plausibly collide with).
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  'replace-me-32-bytes-minimum',
  'replace-me-a-different-32-bytes-minimum',
]);

// A real secret generated per `.env.example`'s own instructions
// (`openssl rand -base64 32`) is 44 base64 characters; 20 is a floor
// loose enough to never reject a legitimately-generated value while
// still catching a short/weak/typo'd one. This does not, and cannot,
// verify the value is actually random — only that it isn't trivially
// short or a known placeholder.
const MIN_SECRET_LENGTH = 20;

function requireStrongSecret(name: string, isProduction: boolean): string {
  const value = requireEnv(name);
  if (KNOWN_PLACEHOLDER_SECRETS.has(value)) {
    throw new Error(
      `${name} is still set to the placeholder value from .env.example. Generate a real secret (e.g. \`openssl rand -base64 32\`) before starting the server.`,
    );
  }
  if (value.length < MIN_SECRET_LENGTH) {
    // A short secret is a real weakness at any time, but only hard-fails
    // in production — local/dev setups sometimes use short throwaway
    // values deliberately, and failing dev boot over it would be more
    // friction than protection for a database nobody but the developer
    // can reach.
    const message = `${name} is only ${value.length} characters — generate a real, random secret of at least ${MIN_SECRET_LENGTH} characters (e.g. \`openssl rand -base64 32\`).`;
    if (isProduction) throw new Error(message);
    // eslint-disable-next-line no-console
    console.warn(`[config] WARNING: ${message}`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  const isProduction = process.env.NODE_ENV === 'production';
  return {
    port: Number(process.env.PORT ?? 4000),
    webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
    databaseUrl: requireEnv('DATABASE_URL'),
    accessTokenSecret: requireStrongSecret('JWT_ACCESS_SECRET', isProduction),
    refreshTokenSecret: requireStrongSecret('JWT_REFRESH_SECRET', isProduction),
    pairingCodePepper: requireStrongSecret('PAIRING_CODE_PEPPER', isProduction),
    googleDriveSharedDriveId: process.env.GOOGLE_DRIVE_SHARED_DRIVE_ID ?? null,
  };
}
