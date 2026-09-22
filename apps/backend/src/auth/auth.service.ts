import { Injectable, UnauthorizedException, NotFoundException, ConflictException, ForbiddenException, Inject } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfig } from '../config/env';
import { APP_CONFIG } from '../config/config.module';
import { hashPassword, verifyPassword } from '../domain/password';
import { issueAccessToken, generateRefreshToken, hashRefreshToken, hashIp } from '../domain/tokens';
import { isLoginLocked, recordFailedLogin, clearLoginLockout } from '../domain/lockout';
import { findMatchingDevice } from '../domain/deviceIdentity';
import { normalizeUsername, nextUsernameChangeAllowedAt } from '../domain/username';
import { RegisterDto, LoginDto } from './dto/auth.dto';
import { ConnectionRegistryService } from '../realtime/connection-registry.service';

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface RequestContext {
  userAgent?: string;
  ip?: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly connections: ConnectionRegistryService,
  ) {}

  /**
   * Recognizes a returning device by its stable identity keys (see
   * domain/deviceIdentity.ts) instead of always creating a new row. This
   * only helps when the client actually presents the same keys again —
   * this app's normal logout deliberately wipes the local identity
   * (AuthContext.tsx: "log out" means "forget this device"), so a
   * matching device is really only found when a session lapses (refresh
   * token expiry, etc.) without an explicit logout in between. That's a
   * real, common case (anyone who hasn't opened the app in 30+ days) and
   * exactly what this fixes; explicit logout-then-login-again is
   * unchanged by design, since the client itself no longer has the old
   * keys to present.
   */
  private async findOrCreateDevice(userId: string, dto: RegisterDto | LoginDto) {
    const existingDevices = await this.prisma.device.findMany({
      where: { userId },
      select: { id: true, identityDhPublic: true, identitySigningPublic: true },
    });
    const match = findMatchingDevice(existingDevices, dto);

    if (match) {
      // Reactivates a previously-revoked device on a legitimate,
      // password-authenticated login — a successful login is a stronger
      // signal of legitimate ownership than the mere act of being logged
      // out was a signal of compromise. Also refreshes the signed
      // pre-key: it's rotated periodically by the client even on a device
      // the server already knows (docs/03-ENCRYPTION-PROTOCOL.md §2), so
      // login is exactly when a newer one should be picked up.
      const device = await this.prisma.device.update({
        where: { id: match.id },
        data: {
          deviceName: dto.deviceName,
          platform: dto.platform === 'android' ? 'ANDROID' : 'WEB',
          signedPrekeyPublic: dto.signedPrekeyPublic,
          signedPrekeySignature: dto.signedPrekeySignature,
          signedPrekeyCreatedAt: new Date(),
          lastSeenAt: new Date(),
          revokedAt: null,
        },
      });
      if (dto.oneTimePrekeysPublic.length > 0) {
        // Additive top-up, not a replace: existing one-time prekeys may
        // already be consumed (mid-handshake with someone) or still
        // legitimately unconsumed, and this device's own client is the
        // only thing that knows which — the server just adds what it's
        // been sent, matching how top-up already works during normal use.
        await this.prisma.oneTimePrekey.createMany({
          data: dto.oneTimePrekeysPublic.map((publicKey) => ({ deviceId: device.id, publicKey })),
        });
      }
      return { device, isNewDevice: false };
    }

    const device = await this.prisma.device.create({
      data: {
        userId,
        deviceName: dto.deviceName,
        platform: dto.platform === 'android' ? 'ANDROID' : 'WEB',
        identityDhPublic: dto.identityDhPublic,
        identitySigningPublic: dto.identitySigningPublic,
        signedPrekeyPublic: dto.signedPrekeyPublic,
        signedPrekeySignature: dto.signedPrekeySignature,
      },
    });
    if (dto.oneTimePrekeysPublic.length > 0) {
      await this.prisma.oneTimePrekey.createMany({
        data: dto.oneTimePrekeysPublic.map((publicKey) => ({ deviceId: device.id, publicKey })),
      });
    }
    return { device, isNewDevice: true };
  }

  private async issueSession(userId: string, deviceId: string, ctx: RequestContext) {
    const accessToken = issueAccessToken({ userId, deviceId }, this.config.accessTokenSecret, ACCESS_TOKEN_TTL_SECONDS);
    const refreshToken = generateRefreshToken();
    await this.prisma.authSession.create({
      data: {
        userId,
        deviceId,
        refreshTokenHash: hashRefreshToken(refreshToken),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
        userAgent: ctx.userAgent?.slice(0, 500) ?? null,
        ipHash: ctx.ip ? hashIp(ctx.ip) : null,
      },
    });
    return { accessToken, refreshToken };
  }

  async register(dto: RegisterDto, ctx: RequestContext) {
    const passwordHash = await hashPassword(dto.password);
    // DTO's own @Transform already normalizes (trim + lowercase) before
    // @IsUsername() ever validates it, so this is defense-in-depth, not
    // the only place normalization happens — cheap enough to be worth
    // never assuming a caller upstream got it right.
    const username = normalizeUsername(dto.username);
    let user;
    try {
      user = await this.prisma.user.create({ data: { passwordHash, username } });
    } catch (err) {
      // The DB's unique constraint is the actual authority on
      // uniqueness — an availability check earlier in the registration
      // flow (GET /api/auth/username-availability) is only ever
      // advisory, since two concurrent registrations for the same name
      // can both pass that check before either has written a row. This
      // is the one place that race is guaranteed to be caught, and a
      // clean 409 here (not a raw DB error) is what makes it safe to
      // expose to the client.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('That username is already taken');
      }
      throw err;
    }
    const { device } = await this.findOrCreateDevice(user.id, dto);
    const tokens = await this.issueSession(user.id, device.id, ctx);
    await this.prisma.securityEvent.create({
      data: { userId: user.id, eventType: 'NEW_DEVICE', metadata: { deviceName: dto.deviceName ?? null } },
    });
    return { userId: user.id, username: user.username, nextUsernameChangeAllowedAt: null, deviceId: device.id, ...tokens };
  }

  /**
   * Advisory only — see the comment in register() on why the DB write
   * there remains the real authority. Used by the pre-registration
   * "is this taken?" UI check (GET /api/auth/username-availability),
   * which by definition runs before any account, and therefore any
   * auth, exists.
   */
  async checkUsernameAvailability(rawUsername: string) {
    const username = normalizeUsername(rawUsername);
    const existing = await this.prisma.user.findUnique({ where: { username }, select: { id: true } });
    return { available: !existing };
  }

  /**
   * userId comes from the access-token guard's context, never the
   * request body — this is always "change MY OWN username," there is no
   * other account this could ever target.
   */
  async changeUsername(userId: string, rawNewUsername: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { username: true, usernameChangedAt: true },
    });
    if (!user) throw new UnauthorizedException();

    const newUsername = normalizeUsername(rawNewUsername);
    if (newUsername === user.username) {
      throw new ConflictException('That is already your username.');
    }

    const nextAllowed = nextUsernameChangeAllowedAt(user.usernameChangedAt);
    if (nextAllowed && nextAllowed > new Date()) {
      // Passed as an object, not a string: ForbiddenException's default
      // string form only ever gives back {statusCode, message, error} —
      // the frontend needs the actual ISO instant to render a real date
      // rather than parse it back out of prose, so this replaces the
      // whole response body with one that carries it. See ChangeUsernameDto's
      // own comment on why the cooldown itself can only be checked here.
      throw new ForbiddenException({
        message: `You can change your username again on ${nextAllowed.toISOString().slice(0, 10)}.`,
        nextUsernameChangeAllowedAt: nextAllowed.toISOString(),
      });
    }

    try {
      const updated = await this.prisma.user.update({
        where: { id: userId },
        data: { username: newUsername, usernameChangedAt: new Date() },
      });
      return {
        username: updated.username,
        nextUsernameChangeAllowedAt: nextUsernameChangeAllowedAt(updated.usernameChangedAt)!.toISOString(),
      };
    } catch (err) {
      // Same DB-is-the-real-authority reasoning as register(): a prior
      // availability check on the frontend is advisory, this write is
      // the actual race-safe check.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('That username is already taken');
      }
      throw err;
    }
  }

  async login(dto: LoginDto, ctx: RequestContext) {
    const user = await this.prisma.user.findUnique({ where: { id: dto.userId } });

    // Always run verifyPassword — even against a placeholder hash when the
    // user doesn't exist — so response timing can't reveal whether a given
    // user id is registered. See docs/01-THREAT-MODEL.md on enumeration.
    const DUMMY_HASH = await hashPassword('this-is-not-a-real-account-do-not-reuse');
    const passwordOk = await verifyPassword(dto.password, user?.passwordHash ?? DUMMY_HASH);

    if (user && isLoginLocked({ failedLoginCount: user.failedLoginCount, lockedUntil: user.lockedUntil })) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user || !passwordOk) {
      if (user) {
        const next = recordFailedLogin({ failedLoginCount: user.failedLoginCount, lockedUntil: user.lockedUntil });
        await this.prisma.user.update({
          where: { id: user.id },
          data: { failedLoginCount: next.failedLoginCount, lockedUntil: next.lockedUntil },
        });
        if (next.lockedUntil) {
          await this.prisma.securityEvent.create({
            data: { userId: user.id, eventType: 'SUSPICIOUS_LOGIN', metadata: { reason: 'lockout_triggered' } },
          });
        }
      }
      // Identical error and shape whether the account doesn't exist, the
      // password is wrong, or the account happens to be locked — no
      // enumeration signal either way.
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.prisma.user.update({ where: { id: user.id }, data: { ...clearLoginLockout(), lastLoginAt: new Date() } });
    const { device, isNewDevice } = await this.findOrCreateDevice(user.id, dto);
    const tokens = await this.issueSession(user.id, device.id, ctx);
    // Only a genuinely new device is worth a security event here — a
    // recognized device logging in again (the whole point of the stable
    // identity above) is routine, not a "new device" notification-worthy
    // event; that distinction is the direct product benefit of this fix.
    if (isNewDevice) {
      await this.prisma.securityEvent.create({
        data: { userId: user.id, eventType: 'NEW_DEVICE', metadata: { deviceName: dto.deviceName ?? null } },
      });
    }
    return {
      userId: user.id,
      username: user.username,
      nextUsernameChangeAllowedAt: nextUsernameChangeAllowedAt(user.usernameChangedAt)?.toISOString() ?? null,
      deviceId: device.id,
      ...tokens,
    };
  }

  async refresh(refreshToken: string) {
    const tokenHash = hashRefreshToken(refreshToken);
    const session = await this.prisma.authSession.findFirst({
      where: { refreshTokenHash: tokenHash, revokedAt: null, expiresAt: { gt: new Date() } },
    });
    if (!session) throw new UnauthorizedException('Session expired or revoked');
    // A revoked device's refresh token could otherwise still mint a fresh
    // access token even though HTTP/WebSocket both now reject that
    // device — this closes the same gap one layer earlier.
    const device = await this.prisma.device.findUnique({ where: { id: session.deviceId }, select: { revokedAt: true } });
    if (!device || device.revokedAt) throw new UnauthorizedException('Session expired or revoked');

    // Rotate on every use: the old refresh token is immediately dead, so a
    // stolen-but-unused-yet token can't be replayed after the legitimate
    // client also uses it (whichever uses it first "wins"; the loser's
    // next refresh attempt fails, which is a strong signal of compromise
    // worth surfacing to the user in a real implementation).
    //
    // THE FIX (found during the final V1 pre-runtime audit): "whichever
    // uses it first wins" wasn't actually true — the update below used
    // to be unconditional (keyed only on session.id), so two concurrent
    // refresh calls presenting the same still-valid token (the same
    // device open in two tabs, both refreshing around the same access-
    // token expiry) would both pass the check above, both generate a
    // *different* new token, and both write — whichever update landed
    // last would silently overwrite the other's, leaving the loser
    // holding a refresh token that was already dead the moment it was
    // handed back in that response, with no error at the time to
    // explain why. The same updateMany-with-a-WHERE-guard idiom already
    // used for pairing-code redemption's own concurrent-redeem race
    // (pairing.service.ts) applies here: only the request that's still
    // looking at the *current* hash is allowed to rotate it, and the
    // loser gets a clean, immediate 401 instead of a token that fails
    // mysteriously on its next use.
    const newRefreshToken = generateRefreshToken();
    const rotated = await this.prisma.authSession.updateMany({
      where: { id: session.id, refreshTokenHash: tokenHash },
      data: { refreshTokenHash: hashRefreshToken(newRefreshToken), expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS) },
    });
    if (rotated.count === 0) throw new UnauthorizedException('Session expired or revoked'); // lost the race to a concurrent refresh
    const accessToken = issueAccessToken(
      { userId: session.userId, deviceId: session.deviceId },
      this.config.accessTokenSecret,
      ACCESS_TOKEN_TTL_SECONDS,
    );
    return { accessToken, refreshToken: newRefreshToken };
  }

  async logout(refreshToken: string) {
    await this.prisma.authSession.updateMany({
      where: { refreshTokenHash: hashRefreshToken(refreshToken) },
      data: { revokedAt: new Date() },
    });
  }

  async listSessions(userId: string, currentDeviceId: string) {
    const sessions = await this.prisma.authSession.findMany({
      where: { userId, revokedAt: null },
      include: { device: true },
      orderBy: { createdAt: 'desc' },
    });
    return sessions.map((s) => ({
      id: s.id,
      deviceId: s.deviceId,
      deviceName: s.device.deviceName,
      platform: s.device.platform,
      userAgent: s.userAgent,
      createdAt: s.createdAt,
      lastSeenAt: s.device.lastSeenAt,
      isCurrentDevice: s.deviceId === currentDeviceId,
      online: this.connections.isDeviceOnline(s.deviceId),
    }));
  }

  /**
   * Shared by revokeSession and revokeOtherSessions: marks both rows
   * revoked, then makes it immediate rather than something the other
   * device would only discover on its next request — pushes
   * SESSION_REVOKED first (best-effort: a device that's already offline
   * simply won't receive it, which is fine, since it'll be rejected on
   * its next reconnect attempt anyway per the revocation check in
   * RealtimeGateway/AccessTokenGuard) and disconnects its live socket(s)
   * shortly after, giving the push a moment to actually reach the client
   * before the connection closes under it.
   */
  private async revokeSessionAndDisconnect(sessionId: string, deviceId: string, reason: string) {
    await this.prisma.authSession.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
    await this.prisma.device.update({ where: { id: deviceId }, data: { revokedAt: new Date() } });
    this.connections.pushToDevice(deviceId, 'session_revoked', { reason });
    setTimeout(() => this.connections.disconnectDevice(deviceId), 250);
  }

  async revokeSession(userId: string, sessionId: string) {
    const session = await this.prisma.authSession.findUnique({ where: { id: sessionId } });
    if (!session || session.userId !== userId) {
      // Same 404 whether it doesn't exist or belongs to someone else — no
      // confirmation that a given session id is valid for a different
      // account. This was previously a ConflictException (409), which
      // didn't match this comment's own stated intent, the harness's
      // mirrored behavior, or the general convention of 404 for "not
      // found or not yours" — found during the HTTP-status-code
      // consistency audit pass. NotFoundException is the correct,
      // consistent status here.
      throw new NotFoundException('Session not found');
    }
    // Idempotent: revoking an already-revoked session is a harmless no-op,
    // not an error — a double-tap on "log out" in the UI, or a retried
    // request after a dropped response, shouldn't fail the second time.
    if (session.revokedAt) return;
    await this.revokeSessionAndDisconnect(sessionId, session.deviceId, 'revoked_by_user');
    await this.prisma.securityEvent.create({ data: { userId, eventType: 'SESSION_REVOKED', metadata: { sessionId } } });
  }

  /** "Log out all other devices" — preserves the caller's own current session untouched. */
  async revokeOtherSessions(userId: string, currentDeviceId: string) {
    const others = await this.prisma.authSession.findMany({
      where: { userId, revokedAt: null, deviceId: { not: currentDeviceId } },
    });
    for (const session of others) {
      await this.revokeSessionAndDisconnect(session.id, session.deviceId, 'revoked_by_user');
    }
    if (others.length > 0) {
      await this.prisma.securityEvent.create({
        data: { userId, eventType: 'SESSION_REVOKED', metadata: { count: others.length, reason: 'revoke_others' } },
      });
    }
    return { revokedCount: others.length };
  }

  async deleteAccount(userId: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid credentials');
    }
    // THE FIX (found during the final pre-runtime audit's API-contract
    // inventory — this endpoint had never been looked at in any prior
    // pass): account deletion cascades away every conversation this user
    // was part of (onDelete: Cascade on both Conversation.userA and
    // Conversation.userB), which is a "this conversation is gone" event
    // for the OTHER participant exactly like burn() — but unlike burn(),
    // nothing here ever told them. burn() gets this right via a live
    // 'conversation_burned' push plus GET /api/conversations/:id still
    // returning a DELETED-status row afterward so an *offline* peer
    // discovers it on their next check. Only the live-push half is
    // replicable here: a hard cascade delete leaves no row behind for
    // GET :id to return anything from, so an offline peer at the moment
    // of this account's deletion has no durable discovery path — that
    // asymmetry is a real, known limitation of built-in cascade delete
    // for this operation specifically, not something this fix pretends
    // to fully close. Reusing burn()'s exact event name/payload rather
    // than inventing a new one: to the surviving party's client, "the
    // other person deleted their account" and "the other person burned
    // this conversation" both mean the same thing — the conversation is
    // over and nothing more should be sent into it — so there's no
    // reason for the frontend to need a second code path to handle it.
    const conversations = await this.prisma.conversation.findMany({
      where: { OR: [{ userAId: userId }, { userBId: userId }] },
      select: { id: true, userAId: true, userBId: true },
    });
    for (const convo of conversations) {
      const otherUserId = convo.userAId === userId ? convo.userBId : convo.userAId;
      this.connections.pushToUser(otherUserId, 'conversation_burned', { conversationId: convo.id });
    }
    // SECURITY AUDIT F5: explicitly disconnect all active WebSocket/device
    // connections for the deleting user so they cannot continue socket operations.
    this.connections.disconnectUser(userId);
    // Cascades to devices/sessions/pairing codes/conversations/messages/
    // security events per the schema's onDelete: Cascade relations.
    await this.prisma.user.delete({ where: { id: userId } });
  }

  /**
   * Requires and verifies the CURRENT password server-side before
   * anything is written — an access token alone (which is all
   * AccessTokenGuard checks) proves "this request came from a session
   * that was valid at login time," not "this person still has the
   * password," and a stolen/leaked token must not be enough on its own
   * to lock the real owner out by changing their credential. Same
   * verify-then-act shape as deleteAccount just above.
   */
  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    const passwordHash = await hashPassword(newPassword);
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash } });
  }
}
