import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { TurnstileService } from '../../../dist/auth/turnstile.service.js';
import { AuthService } from '../../../dist/auth/auth.service.js';
import { AuthController } from '../../../dist/auth/auth.controller.js';

function createMockConfig(overrides: Record<string, any> = {}): any {
  return {
    port: 4000,
    webOrigin: 'http://localhost:3000',
    databaseUrl: 'postgresql://test:test@localhost:5432/test',
    accessTokenSecret: 'a'.repeat(32),
    refreshTokenSecret: 'b'.repeat(32),
    pairingCodePepper: 'c'.repeat(32),
    googleDriveSharedDriveId: null,
    googleDriveClientId: null,
    googleDriveClientSecret: null,
    googleDriveRedirectUri: null,
    googleDriveCredentialKey: null,
    googleClientId: null,
    googleClientSecret: null,
    googleAuthRedirectUri: null,
    smtpHost: null,
    smtpPort: null,
    smtpUser: null,
    smtpPass: null,
    smtpFrom: null,
    smtpSecure: false,
    turnstileSecretKey: '0x4AAAAAAATestSecretKey1234567890',
    ...overrides,
  };
}

test('TurnstileService: verifies valid token with Cloudflare siteverify', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let calledUrl = '';
  let calledBody = '';
  let calledMethod = '';

  globalThis.fetch = async (input, init) => {
    calledUrl = String(input);
    calledMethod = init?.method ?? 'GET';
    calledBody = String(init?.body ?? '');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        challenge_ts: new Date().toISOString(),
        hostname: 'localhost',
      }),
    } as any;
  };

  const config = createMockConfig();
  const service = new TurnstileService(config);

  const result = await service.verifyToken('valid-cf-token', '192.168.1.1');
  assert.equal(result.success, true);
  assert.equal(calledUrl, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
  assert.equal(calledMethod, 'POST');
  assert.ok(calledBody.includes('secret=0x4AAAAAAATestSecretKey1234567890'));
  assert.ok(calledBody.includes('response=valid-cf-token'));
  assert.ok(calledBody.includes('remoteip=192.168.1.1'));
});

test('TurnstileService: rejects invalid token with safe generic error', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: false,
        'error-codes': ['invalid-input-response'],
      }),
    } as any;
  };

  const config = createMockConfig();
  const service = new TurnstileService(config);

  await assert.rejects(
    async () => {
      await service.verifyToken('bad-token');
    },
    (err: any) => {
      assert.ok(err instanceof BadRequestException);
      assert.equal(err.message, 'Security verification failed. Please try again.');
      // Never expose secrets or Cloudflare internal error codes
      assert.ok(!err.message.includes('invalid-input-response'));
      assert.ok(!err.message.includes('secret'));
      return true;
    }
  );
});

test('TurnstileService: rejects expired token with retry notice', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: false,
        'error-codes': ['timeout-or-duplicate'],
      }),
    } as any;
  };

  const config = createMockConfig();
  const service = new TurnstileService(config);

  await assert.rejects(
    async () => {
      await service.verifyToken('expired-token');
    },
    (err: any) => {
      assert.ok(err instanceof BadRequestException);
      assert.equal(err.message, 'Security verification expired. Please complete the challenge again.');
      return true;
    }
  );
});

test('TurnstileService: rejects missing, empty, or whitespace token', async () => {
  const config = createMockConfig();
  const service = new TurnstileService(config);

  for (const emptyToken of ['', '   ', null, undefined]) {
    await assert.rejects(
      async () => {
        await service.verifyToken(emptyToken as any);
      },
      (err: any) => {
        assert.ok(err instanceof BadRequestException);
        assert.equal(err.message, 'Security verification required. Please complete the challenge.');
        return true;
      }
    );
  }
});

test('TurnstileService: fails safely on network or Cloudflare HTTP error', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  // 1. HTTP 502 Bad Gateway
  globalThis.fetch = async () => {
    return {
      ok: false,
      status: 502,
    } as any;
  };

  const config = createMockConfig();
  const service = new TurnstileService(config);

  await assert.rejects(
    async () => {
      await service.verifyToken('test-token');
    },
    (err: any) => {
      assert.ok(err instanceof BadRequestException);
      assert.equal(err.message, 'Security verification unavailable. Please try again in a few moments.');
      return true;
    }
  );

  // 2. Fetch network rejection
  globalThis.fetch = async () => {
    throw new Error('Connection refused');
  };

  await assert.rejects(
    async () => {
      await service.verifyToken('test-token');
    },
    (err: any) => {
      assert.ok(err instanceof BadRequestException);
      assert.equal(err.message, 'Security verification unavailable. Please try again in a few moments.');
      return true;
    }
  );
});

test('TurnstileService: dev mode bypasses verification when unconfigured', async () => {
  const oldNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  try {
    const config = createMockConfig({ turnstileSecretKey: null });
    const service = new TurnstileService(config);

    const result = await service.verifyToken(undefined);
    assert.equal(result.success, true);
    assert.equal(result.bypassed, true);
  } finally {
    process.env.NODE_ENV = oldNodeEnv;
  }
});

test('TurnstileService: production mode fails safely when unconfigured', async () => {
  const oldNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const config = createMockConfig({ turnstileSecretKey: null });
    const service = new TurnstileService(config);

    await assert.rejects(
      async () => {
        await service.verifyToken('any-token');
      },
      (err: any) => {
        assert.ok(err instanceof BadRequestException);
        assert.equal(err.message, 'Security verification is not configured on this server.');
        return true;
      }
    );
  } finally {
    process.env.NODE_ENV = oldNodeEnv;
  }
});

test('AuthService: registration enforces Turnstile verification', async () => {
  let verifyTokenCalled = false;
  const mockTurnstileService = {
    async verifyToken(token?: string | null) {
      verifyTokenCalled = true;
      if (!token || token === 'bad-token') {
        throw new BadRequestException('Security verification failed. Please try again.');
      }
      return { success: true };
    },
  };

  const mockPrisma = {
    user: {
      create: async () => {
        throw new Error('User create should not be called when verification fails');
      },
    },
  };

  const authService = new AuthService(
    mockPrisma,
    createMockConfig(),
    {} as any,
    {} as any,
    mockTurnstileService as any
  );

  // Registration with invalid token fails before hashing or DB writes
  await assert.rejects(
    async () => {
      await authService.register(
        {
          username: 'validuser',
          password: 'Password123!',
          email: 'valid@example.com',
          turnstileToken: 'bad-token',
          identityDhPublic: 'pub1',
          identitySigningPublic: 'pub2',
          signedPrekeyPublic: 'pub3',
          signedPrekeySignature: 'sig',
          oneTimePrekeysPublic: [],
          platform: 'web',
        },
        { ip: '127.0.0.1' }
      );
    },
    (err: any) => {
      assert.ok(err instanceof BadRequestException);
      assert.equal(err.message, 'Security verification failed. Please try again.');
      return true;
    }
  );

  assert.equal(verifyTokenCalled, true);
});

test('AuthService: login conditional challenge triggers at >= 3 consecutive failed attempts', async () => {
  const mockUser = {
    id: 'user-123',
    username: 'pookietester',
    email: 'test@example.com',
    emailVerifiedAt: new Date(),
    passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$dummyhashvalueformockpasswordcheck1234567890',
    failedLoginCount: 0,
    lockedUntil: null,
  };

  const prismaUsers = new Map<string, any>([['user-123', { ...mockUser }]]);

  const mockPrisma = {
    user: {
      findFirst: async () => {
        return prismaUsers.get('user-123');
      },
      update: async ({ where, data }: any) => {
        const u = prismaUsers.get(where.id);
        Object.assign(u, data);
        return u;
      },
    },
    securityEvent: {
      create: async () => ({ id: 'sec-1' }),
    },
  };

  let turnstileVerified = false;
  const mockTurnstileService = {
    async verifyToken(token?: string | null) {
      if (!token || token === 'invalid') {
        throw new BadRequestException('Security verification failed. Please try again.');
      }
      turnstileVerified = true;
      return { success: true };
    },
  };

  const authService = new AuthService(
    mockPrisma,
    createMockConfig(),
    {} as any,
    {} as any,
    mockTurnstileService as any
  );

  const loginDto = {
    identifier: 'pookietester',
    password: 'WrongPassword!',
    platform: 'web',
    identityDhPublic: 'pub1',
    identitySigningPublic: 'pub2',
    signedPrekeyPublic: 'pub3',
    signedPrekeySignature: 'sig',
    oneTimePrekeysPublic: [],
  };

  // Attempt 1: Failed password, failedLoginCount becomes 1, requiresTurnstile = false
  await assert.rejects(
    async () => authService.login(loginDto, { ip: '127.0.0.1' }),
    (err: any) => {
      assert.ok(err instanceof UnauthorizedException);
      const res = err.getResponse();
      assert.equal(res.requiresTurnstile, false);
      return true;
    }
  );
  assert.equal(prismaUsers.get('user-123').failedLoginCount, 1);

  // Attempt 2: Failed password, failedLoginCount becomes 2, requiresTurnstile = false
  await assert.rejects(
    async () => authService.login(loginDto, { ip: '127.0.0.1' }),
    (err: any) => {
      assert.ok(err instanceof UnauthorizedException);
      const res = err.getResponse();
      assert.equal(res.requiresTurnstile, false);
      return true;
    }
  );
  assert.equal(prismaUsers.get('user-123').failedLoginCount, 2);

  // Attempt 3: Failed password, failedLoginCount becomes 3 -> threshold reached! requiresTurnstile = true
  await assert.rejects(
    async () => authService.login(loginDto, { ip: '127.0.0.1' }),
    (err: any) => {
      assert.ok(err instanceof UnauthorizedException);
      const res = err.getResponse();
      assert.equal(res.requiresTurnstile, true);
      return true;
    }
  );
  assert.equal(prismaUsers.get('user-123').failedLoginCount, 3);

  // Attempt 4 without Turnstile token: BLOCKED before password check
  await assert.rejects(
    async () => authService.login(loginDto, { ip: '127.0.0.1' }),
    (err: any) => {
      assert.ok(err instanceof UnauthorizedException);
      const res = err.getResponse();
      assert.equal(res.requiresTurnstile, true);
      assert.equal(res.message, 'Security verification required. Please complete the challenge.');
      return true;
    }
  );

  // Attempt 4 with invalid Turnstile token: BLOCKED by TurnstileService
  await assert.rejects(
    async () => authService.login({ ...loginDto, turnstileToken: 'invalid' }, { ip: '127.0.0.1' }),
    (err: any) => {
      assert.ok(err instanceof BadRequestException);
      assert.equal(err.message, 'Security verification failed. Please try again.');
      return true;
    }
  );

  // Attempt 4 with valid Turnstile token: Turnstile verification passes!
  // Password check runs, still wrong, increments to 4
  turnstileVerified = false;
  await assert.rejects(
    async () => authService.login({ ...loginDto, turnstileToken: 'valid-token' }, { ip: '127.0.0.1' }),
    (err: any) => {
      assert.ok(err instanceof UnauthorizedException);
      const res = err.getResponse();
      assert.equal(res.requiresTurnstile, true);
      return true;
    }
  );
  assert.equal(turnstileVerified, true);
  assert.equal(prismaUsers.get('user-123').failedLoginCount, 4);

  // Attempt 5 with valid Turnstile token: Password fails, hits LOCKOUT_THRESHOLD (5)
  await assert.rejects(
    async () => authService.login({ ...loginDto, turnstileToken: 'valid-token' }, { ip: '127.0.0.1' }),
    (err: any) => {
      assert.ok(err instanceof UnauthorizedException);
      return true;
    }
  );
  const lockedUser = prismaUsers.get('user-123');
  assert.equal(lockedUser.failedLoginCount, 5);
  assert.ok(lockedUser.lockedUntil !== null);
  assert.ok(lockedUser.lockedUntil.getTime() > Date.now());

  // Subsequent attempt while locked is rejected immediately by lockout
  await assert.rejects(
    async () => authService.login({ ...loginDto, turnstileToken: 'valid-token' }, { ip: '127.0.0.1' }),
    (err: any) => {
      assert.ok(err instanceof UnauthorizedException);
      assert.equal(err.message, 'Invalid credentials');
      return true;
    }
  );
});

test('AuthService: successful login resets failed-login state and clears challenge', async () => {
  const { hashPassword } = await import('../../../dist/domain/password.js');
  const validPassword = 'CorrectPassword123!';
  const passwordHash = await hashPassword(validPassword);

  const mockUser = {
    id: 'user-reset-test',
    username: 'resetuser',
    email: 'reset@example.com',
    emailVerifiedAt: new Date(),
    passwordHash,
    failedLoginCount: 4, // Was challenged
    lockedUntil: null,
  };

  let updatedData: any = null;
  const mockPrisma = {
    user: {
      findFirst: async () => ({ ...mockUser }),
      update: async ({ data }: any) => {
        updatedData = data;
        return { ...mockUser, ...data };
      },
    },
    device: {
      findMany: async () => [],
      create: async () => ({ id: 'dev-1' }),
    },
    oneTimePrekey: {
      createMany: async () => ({ count: 0 }),
    },
    authSession: {
      create: async () => ({ id: 'session-1' }),
    },
    securityEvent: {
      create: async () => ({ id: 'sec-1' }),
    },
  };

  const mockTurnstileService = {
    async verifyToken() {
      return { success: true };
    },
  };

  const authService = new AuthService(
    mockPrisma as any,
    createMockConfig(),
    {} as any,
    {} as any,
    mockTurnstileService as any
  );

  const result = await authService.login(
    {
      identifier: 'resetuser',
      password: validPassword,
      turnstileToken: 'valid-token',
      platform: 'web',
      identityDhPublic: 'pub1',
      identitySigningPublic: 'pub2',
      signedPrekeyPublic: 'pub3',
      signedPrekeySignature: 'sig',
      oneTimePrekeysPublic: [],
    },
    { ip: '127.0.0.1' }
  );

  assert.ok(result.accessToken);
  assert.ok(result.refreshToken);
  // Verify failedLoginCount and lockedUntil are reset to 0 and null
  assert.equal(updatedData.failedLoginCount, 0);
  assert.equal(updatedData.lockedUntil, null);
});

test('Rate limiting: all auth endpoints maintain @Throttle protections', () => {
  const THROTTLER_LIMIT = 'THROTTLER:LIMITdefault';
  
  // Inspect metadata on AuthController methods
  const registerLimit = Reflect.getMetadata(THROTTLER_LIMIT, AuthController.prototype.register);
  assert.equal(registerLimit, 10, 'register must have @Throttle limit 10');

  const loginLimit = Reflect.getMetadata(THROTTLER_LIMIT, AuthController.prototype.login);
  assert.equal(loginLimit, 10, 'login must have @Throttle limit 10');

  const verifyEmailLimit = Reflect.getMetadata(THROTTLER_LIMIT, AuthController.prototype.verifyEmail);
  assert.equal(verifyEmailLimit, 15, 'verify-email must have @Throttle limit 15');

  const resendLimit = Reflect.getMetadata(THROTTLER_LIMIT, AuthController.prototype.resendVerification);
  assert.equal(resendLimit, 5, 'resend-verification must have @Throttle limit 5');

  const googleUrlLimit = Reflect.getMetadata(THROTTLER_LIMIT, AuthController.prototype.getGoogleAuthUrl);
  assert.equal(googleUrlLimit, 20, 'google/url must have @Throttle limit 20');
});
