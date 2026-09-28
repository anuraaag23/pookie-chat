import test from 'node:test';
import assert from 'node:assert/strict';
import { GoogleAuthService } from '../../../dist/auth/google-auth.service.js';
import { signOAuthState, verifyOAuthState } from '../../domain/oauthState.ts';

const TEST_SECRET = 'secret-must-be-long-enough-for-safety-12345';

test('GoogleAuthService: isConfigured reflects clientId presence', () => {
  const serviceUnconfigured = new GoogleAuthService({
    googleClientId: null,
    accessTokenSecret: TEST_SECRET,
  } as any);
  assert.equal(serviceUnconfigured.isConfigured(), false);
  assert.equal(serviceUnconfigured.getConfig().configured, false);
  assert.throws(() => serviceUnconfigured.getOAuthClient(), /not configured/);

  const serviceConfigured = new GoogleAuthService({
    googleClientId: 'test-client-id.apps.googleusercontent.com',
    googleClientSecret: 'test-secret',
    webOrigin: 'http://localhost:3000',
    accessTokenSecret: TEST_SECRET,
  } as any);
  assert.equal(serviceConfigured.isConfigured(), true);
  assert.equal(serviceConfigured.getConfig().configured, true);
  assert.equal(serviceConfigured.getConfig().clientId, 'test-client-id.apps.googleusercontent.com');
});

test('GoogleAuthService: generateAuthUrl produces correct OAuth2 URL', () => {
  const service = new GoogleAuthService({
    googleClientId: 'test-client-id.apps.googleusercontent.com',
    googleClientSecret: 'test-secret',
    webOrigin: 'http://localhost:3000',
    accessTokenSecret: TEST_SECRET,
  } as any);

  const { authUrl } = service.generateAuthUrl('login', '/chat');
  assert.ok(authUrl.startsWith('https://accounts.google.com/o/oauth2/v2/auth'));
  assert.ok(authUrl.includes('client_id=test-client-id.apps.googleusercontent.com'));
  assert.ok(authUrl.includes('scope=openid+email+profile') || authUrl.includes('scope=openid%20email%20profile'));
  assert.ok(authUrl.includes('state='));
});

test('GoogleAuthService: ticket lifecycle (create, consume, single-use, expiry)', () => {
  const service = new GoogleAuthService({
    googleClientId: 'test-client-id',
    accessTokenSecret: TEST_SECRET,
  } as any);

  const profile = {
    sub: 'google-sub-123',
    email: 'alice@example.com',
    name: 'Alice',
  };

  const ticketId = service.createTicket(profile);
  assert.ok(ticketId && typeof ticketId === 'string');

  // First consumption succeeds
  const consumed = service.consumeTicket(ticketId);
  assert.equal(consumed.sub, 'google-sub-123');
  assert.equal(consumed.email, 'alice@example.com');
  assert.equal(consumed.name, 'Alice');

  // Second consumption fails (single-use replay protection)
  assert.throws(() => service.consumeTicket(ticketId), /Invalid or expired/);

  // Non-existent ticket fails
  assert.throws(() => service.consumeTicket('non-existent-ticket-uuid'), /Invalid or expired/);
});

test('GoogleAuthService: OAuth state signature and tampering defense', () => {
  const state = signOAuthState('auth:login:%2Fchat', TEST_SECRET);
  assert.ok(state.includes('.'));

  // Valid state verifies
  const verified = verifyOAuthState(state, TEST_SECRET);
  assert.equal(verified, 'auth:login:%2Fchat');

  // Tampered state fails
  const tampered = state.slice(0, -3) + 'xyz';
  assert.throws(() => verifyOAuthState(tampered, TEST_SECRET), /Invalid OAuth state signature/);

  // Wrong secret fails
  assert.throws(() => verifyOAuthState(state, 'wrong-secret-that-does-not-match'), /Invalid OAuth state signature/);
});

test('GoogleAuthService: verifyIdToken rejects Google identity if email_verified is false', async () => {
  const service = new GoogleAuthService({
    googleClientId: 'test-client-id',
    accessTokenSecret: TEST_SECRET,
  } as any);

  // Mock getOAuthClient to simulate Google token returning email_verified: false
  service.getOAuthClient = () =>
    ({
      verifyIdToken: async () => ({
        getPayload: () => ({
          sub: 'google-sub-456',
          email: 'unverified-google@example.com',
          email_verified: false,
        }),
      }),
    }) as any;

  await assert.rejects(
    async () => {
      await service.verifyIdToken('dummy-token');
    },
    /Google email is not verified/
  );
});

test('AuthService.loginOrRegisterGoogleUser: links existing unverified local account and marks email verified', async () => {
  const { AuthService } = await import('../../../dist/auth/auth.service.js');

  let updatedUser: any = null;
  let consumedChallenges: any = null;
  let createdDevice: any = null;
  let createdSession: any = null;

  const mockPrisma: any = {
    user: {
      findUnique: async ({ where }: any) => {
        if (where.email === 'alice@example.com') {
          return {
            id: 'user-alice-123',
            username: 'alice',
            email: 'alice@example.com',
            emailVerifiedAt: null, // Local account exists but unverified!
            failedLoginCount: 1,
            lockedUntil: null,
            usernameChangedAt: null,
          };
        }
        return null;
      },
      update: async ({ where, data }: any) => {
        updatedUser = data;
        return { id: where.id, ...data };
      },
    },
    emailVerification: {
      updateMany: async ({ where, data }: any) => {
        consumedChallenges = { where, data };
        return { count: 1 };
      },
    },
    device: {
      findFirst: async () => null,
      findMany: async () => [],
      create: async ({ data }: any) => {
        createdDevice = { id: 'device-abc-1', ...data };
        return createdDevice;
      },
      update: async ({ data }: any) => data,
    },
    authSession: {
      create: async ({ data }: any) => {
        createdSession = data;
        return { id: 'session-xyz', ...data };
      },
    },
    oneTimePrekey: {
      createMany: async () => ({ count: 2 }),
    },
    securityEvent: {
      create: async () => ({ id: 'sec-event-1' }),
    },
    $transaction: async (arg: any) => {
      if (Array.isArray(arg)) {
        return Promise.all(arg);
      }
      return arg(mockPrisma);
    },
  };

  const config: any = {
    accessTokenSecret: TEST_SECRET,
    refreshTokenSecret: TEST_SECRET,
  };

  const authService = new AuthService(
    mockPrisma,
    config,
    { pushToUser: () => {} } as any,
    { sendVerificationEmail: async () => {} } as any,
    { verifyToken: async () => true } as any
  );

  const deviceDto: any = {
    deviceName: 'MacBook Pro',
    platform: 'web',
    identityDhPublic: 'dh-pub-key-1',
    identitySigningPublic: 'sign-pub-key-1',
    signedPrekeyPublic: 'prekey-pub-1',
    signedPrekeySignature: 'prekey-sig-1',
    oneTimePrekeysPublic: ['ot-1', 'ot-2'],
  };

  const result = await authService.loginOrRegisterGoogleUser(
    { sub: 'google-sub-alice', email: 'alice@example.com', name: 'Alice' },
    deviceDto,
    { ip: '127.0.0.1', userAgent: 'test-agent' }
  );

  // Assert account was linked and verified
  assert.equal(result.userId, 'user-alice-123');
  assert.equal(result.emailVerified, true);
  assert.ok(result.accessToken);
  assert.ok(result.refreshToken);
  assert.ok(updatedUser?.emailVerifiedAt instanceof Date);
  assert.equal(updatedUser?.failedLoginCount, 0);
  assert.equal(consumedChallenges?.where?.userId, 'user-alice-123');
  assert.ok(consumedChallenges?.data?.consumedAt instanceof Date);
});

test('AuthService.login: password login still rejects unverified local account', async () => {
  const { AuthService } = await import('../../../dist/auth/auth.service.js');
  const { hashPassword } = await import('../../../dist/domain/password.js');

  const passwordHash = await hashPassword('SecretPassword123!');
  const mockPrisma: any = {
    user: {
      findFirst: async () => ({
        id: 'user-bob-456',
        username: 'bob',
        email: 'bob@example.com',
        emailVerifiedAt: null, // Unverified
        passwordHash,
        failedLoginCount: 0,
        lockedUntil: null,
      }),
      update: async () => ({}),
    },
  };

  const config: any = {
    accessTokenSecret: TEST_SECRET,
    refreshTokenSecret: TEST_SECRET,
  };

  const authService = new AuthService(
    mockPrisma,
    config,
    {} as any,
    {} as any,
    {} as any
  );

  await assert.rejects(
    async () => {
      await authService.login(
        {
          identifier: 'bob@example.com',
          password: 'SecretPassword123!',
          platform: 'web',
          identityDhPublic: 'pub1',
          identitySigningPublic: 'pub2',
          signedPrekeyPublic: 'pub3',
          signedPrekeySignature: 'sig',
        },
        { ip: '127.0.0.1' }
      );
    },
    /Please verify your email before signing in/
  );
});

