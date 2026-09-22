'use client';

import { createContext, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { generateDeviceIdentity, toPublicBundle, DeviceIdentity } from '../crypto/engine';
import { idbGet, idbSet, idbClear } from '../storage/localDb';
import { deleteSession } from '../crypto/sessionStore';
import { clearCachedMessages } from '../crypto/messageCache';
import { api, setTokens, getTokens, setSessionExpiredHandler } from '../api/client';
import { connectSocket, disconnectSocket } from '../realtime/socket';

interface AuthState {
  userId: string | null;
  deviceId: string | null;
  // Public, unique handle (see apps/backend/src/domain/username.ts) —
  // distinct from any future free-text displayName. Populated from the
  // register/login response and persisted locally alongside userId so
  // it survives a reload without an extra round trip; there is no
  // GET /api/auth/me to (re-)fetch it from otherwise.
  username: string | null;
  // ISO instant, or null if the username has never been changed (no
  // cooldown). This is purely DISPLAY data the backend already computed
  // (see AuthService.changeUsername) — the Settings page renders it,
  // it never decides anything on its own; the server re-checks the
  // cooldown for real on every actual PATCH /api/auth/username attempt.
  nextUsernameChangeAllowedAt: string | null;
  email: string | null;
  loading: boolean;
  register: (password: string, username: string, deviceName: string, email?: string) => Promise<{ emailVerificationRequired: boolean; email?: string }>;
  login: (identifier: string, password: string, deviceName: string) => Promise<void>;
  logout: () => Promise<void>;
  setConfirmedUsername: (username: string, nextUsernameChangeAllowedAt: string | null) => Promise<void>;
  verifyEmail: (email: string, code: string) => Promise<void>;
  resendVerification: (email: string) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

async function getOrCreateIdentity(): Promise<DeviceIdentity> {
  const existing = await idbGet<DeviceIdentity>('crypto:identity');
  if (existing) return existing;
  // No identity stored locally: either a brand-new install, or local
  // storage was cleared. Either way, a fresh identity is generated — per
  // docs/03-ENCRYPTION-PROTOCOL.md §11, there is no key escrow to recover
  // an old one from, by design.
  const identity = await generateDeviceIdentity(20);
  await idbSet('crypto:identity', identity);
  return identity;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [userId, setUserId] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [nextUsernameChangeAllowedAt, setNextUsernameChangeAllowedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  // Avoids a double-clear/double-redirect if session_revoked somehow fires
  // more than once (e.g. a reconnect that also gets rejected) before the
  // socket is torn down.
  const clearingRef = useRef(false);

  async function clearAuthState() {
    if (clearingRef.current) return;
    clearingRef.current = true;
    disconnectSocket();
    // Wipes the identity too: on this app "signed out" means "forget this
    // device," the same as an explicit logout — see the comment on
    // logout() below. A device being remotely logged out is exactly the
    // case (lost, stolen, or the owner just wants it fully signed out)
    // where leaving decryptable key material behind would be the wrong
    // default.
    await idbClear();
    setUserId(null);
    setDeviceId(null);
    setUsername(null);
    setEmail(null);
    setNextUsernameChangeAllowedAt(null);
    router.push('/login');
  }

  // Registered unconditionally at mount, not inside the `if (!userId)
  // return` guard any other effect here uses — a dead refresh token can
  // surface from a call made before userId is even known to be set (the
  // very first bootstrap read below), not only while a conversation
  // screen is mounted. Previously nothing was listening for this at all:
  // client.ts's api() would keep returning ApiError(401, ...) forever
  // after a refresh failure, and every screen just saw its own isolated
  // failed request with no way to tell "this call failed" apart from
  // "this session is actually dead" — the user would sit on a page that
  // silently stopped working, with no path back to /login short of
  // manually finding the logout button (if that request itself even
  // still worked). This is the missing other half of session_revoked's
  // WebSocket-push path: that handles the case where this device is
  // online to receive it live; this handles the case where the session
  // died while offline (a naturally expired 30-day refresh token, or a
  // revocation that happened while disconnected) and is only discovered
  // the next time this device tries to actually use it.
  useEffect(() => {
    setSessionExpiredHandler(() => clearAuthState());
    return () => setSessionExpiredHandler(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    (async () => {
      const tokens = await getTokens();
      const session = await idbGet<{ userId: string; deviceId: string; username?: string; email?: string | null; nextUsernameChangeAllowedAt?: string | null }>(
        'auth:session',
      );
      if (tokens && session) {
        setUserId(session.userId);
        setDeviceId(session.deviceId);
        setUsername(session.username ?? null);
        setEmail(session.email ?? null);
        setNextUsernameChangeAllowedAt(session.nextUsernameChangeAllowedAt ?? null);
      }
      setLoading(false);
    })();
  }, []);

  // A live connection whenever authenticated — not only while a
  // conversation happens to be open, which is the only other place this
  // connects. Without this, a remote "log out this device" would only
  // take effect the next time this device opened a chat, not immediately
  // regardless of what screen it's on.
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      const socket = await connectSocket().catch(() => null);
      if (!socket || cancelled) return;
      socket.on('session_revoked', () => {
        clearAuthState();
      });
      // Proactively clears a burned conversation's local session+cache
      // app-wide — not just when app/chat/[conversationId]/page.tsx
      // happens to have that exact conversation open (it has its own
      // listener on this same shared socket for that case). This is what
      // makes the *next* time the user opens this conversation, from the
      // chat list or a stored link, correctly find no session rather
      // than depending solely on the per-page bootstrap-time check to
      // catch it — belt-and-suspenders with
      // ConversationsService.getStatus, not a replacement for it.
      socket.on('conversation_burned', (evt: { conversationId: string }) => {
        deleteSession(evt.conversationId);
        clearCachedMessages(evt.conversationId);
      });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  async function register(password: string, username: string, deviceName: string, emailInput?: string) {
    const identity = await getOrCreateIdentity();
    const bundle = toPublicBundle(identity);
    const result = await api<{
      userId: string;
      username: string;
      email?: string | null;
      emailVerificationRequired?: boolean;
      nextUsernameChangeAllowedAt: string | null;
      deviceId: string;
      accessToken: string;
      refreshToken: string;
    }>('/api/auth/register', {
      method: 'POST',
      authenticated: false,
      body: {
        password,
        username,
        email: emailInput && emailInput.trim() ? emailInput.trim() : undefined,
        deviceName,
        platform: 'web',
        identityDhPublic: bundle.identityDhPublic,
        identitySigningPublic: bundle.identitySigningPublic,
        signedPrekeyPublic: bundle.signedPrekeyPublic,
        signedPrekeySignature: bundle.signedPrekeySignature,
        oneTimePrekeysPublic: identity.oneTimePrekeysPublic,
      },
    });
    await setTokens({ accessToken: result.accessToken, refreshToken: result.refreshToken });
    await idbSet('auth:session', {
      userId: result.userId,
      deviceId: result.deviceId,
      username: result.username,
      email: result.email ?? null,
      nextUsernameChangeAllowedAt: result.nextUsernameChangeAllowedAt,
    });
    setUserId(result.userId);
    setDeviceId(result.deviceId);
    setUsername(result.username);
    setEmail(result.email ?? null);
    setNextUsernameChangeAllowedAt(result.nextUsernameChangeAllowedAt);
    return {
      emailVerificationRequired: !!result.emailVerificationRequired,
      email: result.email ?? undefined,
    };
  }

  async function verifyEmail(targetEmail: string, code: string) {
    await api('/api/auth/verify-email', {
      method: 'POST',
      authenticated: false,
      body: { email: targetEmail.trim(), code: code.trim() },
    });
  }

  async function resendVerification(targetEmail: string) {
    await api('/api/auth/resend-verification', {
      method: 'POST',
      authenticated: false,
      body: { email: targetEmail.trim() },
    });
  }

  async function login(identifier: string, password: string, deviceName: string) {
    const identity = await getOrCreateIdentity();
    const bundle = toPublicBundle(identity);
    const result = await api<{
      userId: string;
      username: string;
      nextUsernameChangeAllowedAt: string | null;
      deviceId: string;
      accessToken: string;
      refreshToken: string;
    }>('/api/auth/login', {
      method: 'POST',
      authenticated: false,
      body: {
        identifier,
        userId: identifier,
        password,
        deviceName,
        platform: 'web',
        identityDhPublic: bundle.identityDhPublic,
        identitySigningPublic: bundle.identitySigningPublic,
        signedPrekeyPublic: bundle.signedPrekeyPublic,
        signedPrekeySignature: bundle.signedPrekeySignature,
        oneTimePrekeysPublic: identity.oneTimePrekeysPublic,
      },
    });
    await setTokens({ accessToken: result.accessToken, refreshToken: result.refreshToken });
    await idbSet('auth:session', {
      userId: result.userId,
      deviceId: result.deviceId,
      username: result.username,
      nextUsernameChangeAllowedAt: result.nextUsernameChangeAllowedAt,
    });
    setUserId(result.userId);
    setDeviceId(result.deviceId);
    setUsername(result.username);
    setNextUsernameChangeAllowedAt(result.nextUsernameChangeAllowedAt);
  }

  /**
   * Called by the Settings page only after PATCH /api/auth/username has
   * already succeeded — this updates local state/persistence to match
   * what the server just confirmed, it never decides a username change
   * on its own.
   */
  async function setConfirmedUsername(newUsername: string, newNextUsernameChangeAllowedAt: string | null) {
    setUsername(newUsername);
    setNextUsernameChangeAllowedAt(newNextUsernameChangeAllowedAt);
    const session = await idbGet<{ userId: string; deviceId: string; username?: string; email?: string | null; nextUsernameChangeAllowedAt?: string | null }>(
      'auth:session',
    );
    if (session) {
      await idbSet('auth:session', { ...session, username: newUsername, nextUsernameChangeAllowedAt: newNextUsernameChangeAllowedAt });
    }
  }

  async function logout() {
    const tokens = await getTokens();
    if (tokens) {
      await api('/api/auth/logout', { method: 'POST', authenticated: false, body: { refreshToken: tokens.refreshToken } }).catch(
        () => {
          // Best-effort — even if the network call fails, still wipe local state below.
        },
      );
    }
    // This is "log out," which on this app means "forget this device." A
    // gentler "just sign out, keep my keys for next time" mode is a
    // reasonable future addition; today it isn't implemented, and
    // pretending it is would be exactly the kind of gap this project
    // asked not to paper over.
    await clearAuthState();
  }

  return (
    <AuthContext.Provider
      value={{
        userId,
        deviceId,
        username,
        email,
        nextUsernameChangeAllowedAt,
        loading,
        register,
        login,
        logout,
        setConfirmedUsername,
        verifyEmail,
        resendVerification,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
