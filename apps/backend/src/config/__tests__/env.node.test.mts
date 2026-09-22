import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../env.ts';

// loadConfig() reads directly from process.env — these tests mutate it
// and always restore the exact prior snapshot afterward (in a finally),
// so a failure partway through a test can't leak env vars into a later,
// unrelated test in this same process.
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prior: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) prior[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return fn();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// A realistic, sufficiently long, non-placeholder value for whichever
// secret a given test isn't specifically exercising — `openssl rand
// -base64 32` produces something this shape.
const REAL_SECRET = 'k3x9QwErTyUiOpAsDfGhJkLzXcVbNm1234567890AB';

function baseEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    JWT_ACCESS_SECRET: REAL_SECRET,
    JWT_REFRESH_SECRET: REAL_SECRET + '-2',
    PAIRING_CODE_PEPPER: REAL_SECRET + '-3',
    GOOGLE_DRIVE_SHARED_DRIVE_ID: undefined,
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '587',
    SMTP_USER: 'smtp-user',
    SMTP_PASS: 'smtp-real-password-12345',
    SMTP_FROM: 'noreply@example.com',
    ...overrides,
  };
}

test('env: loads successfully with real, distinct, sufficiently long secrets', () => {
  withEnv(baseEnv(), () => {
    const config = loadConfig();
    assert.equal(config.databaseUrl, 'postgresql://user:pass@localhost:5432/db');
    assert.equal(config.accessTokenSecret, REAL_SECRET);
  });
});

test('env: missing a required variable fails fast with a clear message', () => {
  withEnv(baseEnv({ DATABASE_URL: undefined }), () => {
    assert.throws(() => loadConfig(), /Missing required environment variable: DATABASE_URL/);
  });
});

test('env: THE FIX — the exact .env.example placeholder value is rejected, even in development', () => {
  // Regardless of NODE_ENV: a placeholder secret is never acceptable,
  // not just discouraged in production. Development is exactly where a
  // freshly-copied .env.example is most likely to still be sitting
  // unedited.
  withEnv(baseEnv({ NODE_ENV: 'development', JWT_ACCESS_SECRET: 'replace-me-32-bytes-minimum' }), () => {
    assert.throws(() => loadConfig(), /still set to the placeholder value/);
  });
  withEnv(baseEnv({ NODE_ENV: 'production', JWT_REFRESH_SECRET: 'replace-me-a-different-32-bytes-minimum' }), () => {
    assert.throws(() => loadConfig(), /still set to the placeholder value/);
  });
});

test('env: THE FIX — a too-short secret hard-fails boot in production', () => {
  withEnv(baseEnv({ NODE_ENV: 'production', PAIRING_CODE_PEPPER: 'short' }), () => {
    assert.throws(() => loadConfig(), /PAIRING_CODE_PEPPER is only 5 characters/);
  });
});

test('env: a too-short secret only warns (does not throw) outside production', () => {
  withEnv(baseEnv({ NODE_ENV: 'development', PAIRING_CODE_PEPPER: 'short' }), () => {
    assert.doesNotThrow(() => loadConfig());
  });
  // NODE_ENV entirely unset is treated the same as non-production —
  // matches every other part of this codebase's "no NODE_ENV usage
  // defaults to the permissive/dev path" convention (see main.ts/
  // config.module.ts, which have none at all).
  withEnv(baseEnv({ NODE_ENV: undefined, PAIRING_CODE_PEPPER: 'short' }), () => {
    assert.doesNotThrow(() => loadConfig());
  });
});

test('env: a secret right at the minimum length boundary is accepted', () => {
  const exactly20 = 'a'.repeat(20);
  withEnv(baseEnv({ NODE_ENV: 'production', JWT_ACCESS_SECRET: exactly20 }), () => {
    assert.doesNotThrow(() => loadConfig());
  });
  withEnv(baseEnv({ NODE_ENV: 'production', JWT_ACCESS_SECRET: 'a'.repeat(19) }), () => {
    assert.throws(() => loadConfig(), /JWT_ACCESS_SECRET is only 19 characters/);
  });
});

test('env: googleDriveSharedDriveId is optional and defaults to null', () => {
  withEnv(baseEnv(), () => {
    assert.equal(loadConfig().googleDriveSharedDriveId, null);
  });
  withEnv(baseEnv({ GOOGLE_DRIVE_SHARED_DRIVE_ID: 'drive-123' }), () => {
    assert.equal(loadConfig().googleDriveSharedDriveId, 'drive-123');
  });
});

test('env: production requires SMTP configuration and rejects placeholder values', () => {
  withEnv(baseEnv({ NODE_ENV: 'production', SMTP_PASS: 'replace-me-smtp-password' }), () => {
    assert.throws(() => loadConfig(), /SMTP_PASS is still set to the placeholder value/);
  });
  withEnv(baseEnv({ NODE_ENV: 'production', SMTP_HOST: undefined }), () => {
    assert.throws(() => loadConfig(), /Missing required environment variable: SMTP_HOST/);
  });
});

test('env: Google Drive config validation catches partial or weak secrets', () => {
  withEnv(baseEnv({ GOOGLE_DRIVE_CLIENT_ID: 'client-123' }), () => {
    assert.throws(() => loadConfig(), /Incomplete Google Drive configuration/);
  });
  withEnv(
    baseEnv({
      NODE_ENV: 'production',
      GOOGLE_DRIVE_CLIENT_ID: 'client-123',
      GOOGLE_DRIVE_CLIENT_SECRET: 'secret-123',
      GOOGLE_DRIVE_REDIRECT_URI: 'https://example.com/oauth/callback',
      GOOGLE_DRIVE_CREDENTIAL_KEY: undefined,
    }),
    () => {
      assert.throws(() => loadConfig(), /GOOGLE_DRIVE_CREDENTIAL_KEY is required in production/);
    },
  );
  withEnv(
    baseEnv({
      NODE_ENV: 'production',
      GOOGLE_DRIVE_CLIENT_ID: 'client-123',
      GOOGLE_DRIVE_CLIENT_SECRET: 'secret-123',
      GOOGLE_DRIVE_REDIRECT_URI: 'https://example.com/oauth/callback',
      GOOGLE_DRIVE_CREDENTIAL_KEY: 'a'.repeat(32),
    }),
    () => {
      assert.doesNotThrow(() => loadConfig());
    },
  );
});

