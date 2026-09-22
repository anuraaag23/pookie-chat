'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { NeoSurface } from '@/components/ui/NeoSurface';
import { NeoInput } from '@/components/ui/NeoInput';
import { TabBar } from '@/components/chat/TabBar';
import { useAuth } from '@/lib/auth/AuthContext';
import { api, ApiError } from '@/lib/api/client';
import { idbSet } from '@/lib/storage/localDb';
import { hashLocalSecret } from '@/lib/localauth/localSecret';
import { setAppLockEnabled, setAppLockTimeoutSeconds, recordActivity } from '@/lib/applock/state';
import { normalizeUsername, validateUsername } from '@/lib/username';

const ACCENT_OPTIONS: { label: string; value: string | null }[] = [
  { label: 'Default (blue)', value: null },
  { label: 'Violet', value: '#8B5CF6' },
  { label: 'Pink', value: '#EC4899' },
  { label: 'Amber', value: '#F59E0B' },
  { label: 'Teal', value: '#14B8A6' },
];

// 0 = "Immediately" — see the field's own comment in
// settings.controller.ts's UpdateSettingsDto for what that actually
// means in the app-lock lifecycle (AppLockGate/state.ts).
const APP_LOCK_TIMEOUT_OPTIONS: { label: string; seconds: number }[] = [
  { label: 'Immediately', seconds: 0 },
  { label: '30s', seconds: 30 },
  { label: '1 min', seconds: 60 },
  { label: '5 min', seconds: 300 },
  { label: '15 min', seconds: 900 },
];

interface Settings {
  readReceiptsEnabled: boolean;
  typingIndicatorEnabled: boolean;
  notificationContentVisible: boolean;
  accentColor: string | null;
  appLockEnabled: boolean;
  appLockTimeoutSeconds: number;
  screenshotProtectionEnabled: boolean;
  usernameSearchEnabled: boolean;
}

interface SessionEntry {
  id: string;
  deviceId: string;
  deviceName: string | null;
  platform: string;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  isCurrentDevice: boolean;
  online: boolean;
}

export default function SettingsPage() {
  const { userId, username, nextUsernameChangeAllowedAt, logout, setConfirmedUsername } = useAuth();
  const router = useRouter();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Truthful per-write status for the generic settings PATCH path (item
  // 6): 'idle' shows nothing, 'saving' while the request is in flight,
  // 'saved' briefly after a confirmed 200, auto-clearing back to idle —
  // never shown before the server actually confirms. A failure leaves
  // saveState at 'idle' and relies on saveError (below) instead, since
  // "saved" and "failed" are mutually exclusive, not two independent
  // flags.
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  // What to resend if the person taps Retry on a failed save — without
  // this, "Retry" would either do nothing or silently retry the wrong
  // (possibly since-superseded) change.
  const [lastFailedPatch, setLastFailedPatch] = useState<Partial<Settings> | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [appLockPin, setAppLockPin] = useState('');
  const [appLockTimeout, setAppLockTimeout] = useState(60);

  function loadSettings() {
    setLoadError(false);
    api<Settings>('/api/settings')
      .then(setSettings)
      .catch(() => setLoadError(true));
  }

  useEffect(() => {
    loadSettings();
    function refreshSessions() {
      api<SessionEntry[]>('/api/auth/sessions').then(setSessions).catch(() => {});
    }
    refreshSessions();
    // Online status and a device disconnecting elsewhere aren't pushed to
    // this page — it isn't a live view the way the chat screen is, so a
    // light poll is enough to keep "online now" from going stale while
    // Settings is open, without needing its own socket listeners.
    const interval = setInterval(refreshSessions, 15_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (settings) setAppLockTimeout(settings.appLockTimeoutSeconds);
  }, [settings?.appLockTimeoutSeconds]);

  async function updateSettings(patch: Partial<Settings>) {
    if (!settings) return;
    const previous = settings;
    const next = { ...settings, ...patch };
    setSettings(next);
    setSaveError(null);
    setLastFailedPatch(null);
    setSaveState('saving');
    try {
      await api('/api/settings', { method: 'PATCH', body: patch });
      setSaveState('saved');
      setTimeout(() => setSaveState((s) => (s === 'saved' ? 'idle' : s)), 2000);
    } catch {
      // Roll back the optimistic update rather than leaving the toggle
      // showing a state the server never actually accepted — previously
      // a failed PATCH here (network drop, an expired session that
      // couldn't silently refresh) left local state permanently
      // disagreeing with what's actually persisted, with the toggle
      // still visually "on" and no indication anything went wrong.
      setSettings(previous);
      setSaveState('idle');
      setSaveError("Couldn't save that change.");
      setLastFailedPatch(patch);
    }
  }

  function retryLastChange() {
    if (lastFailedPatch) updateSettings(lastFailedPatch);
  }

  // --- Change username: same validation policy as registration
  // (lib/username.ts, mirroring apps/backend/src/domain/username.ts),
  // same debounced advisory availability check, but with a cooldown the
  // registration flow doesn't have. The cooldown display here is pure
  // presentation of what the backend already told us (see
  // AuthContext.nextUsernameChangeAllowedAt's own comment) — the actual
  // enforcement happens again, for real, on the PATCH below. ---
  const [showChangeUsername, setShowChangeUsername] = useState(false);
  const [newUsernameInput, setNewUsernameInput] = useState('');
  const [usernameAvailable, setUsernameAvailable] = useState<boolean | null>(null);
  const [checkingUsernameAvailability, setCheckingUsernameAvailability] = useState(false);
  const [usernameChangeState, setUsernameChangeState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [usernameChangeError, setUsernameChangeError] = useState<string | null>(null);

  const normalizedNewUsername = normalizeUsername(newUsernameInput);
  const newUsernameValidation = validateUsername(normalizedNewUsername);
  const isCurrentUsername = username !== null && normalizedNewUsername === username;
  const cooldownActive = !!nextUsernameChangeAllowedAt && new Date(nextUsernameChangeAllowedAt) > new Date();
  const cooldownDateLabel = nextUsernameChangeAllowedAt ? new Date(nextUsernameChangeAllowedAt).toLocaleDateString() : null;

  const usernameAvailabilityRequestId = useRef(0);
  useEffect(() => {
    setUsernameAvailable(null);
    if (!newUsernameValidation.valid || isCurrentUsername) return;
    const thisRequestId = ++usernameAvailabilityRequestId.current;
    setCheckingUsernameAvailability(true);
    const timer = setTimeout(async () => {
      try {
        const result = await api<{ available: boolean }>(
          `/api/auth/username-availability?username=${encodeURIComponent(normalizedNewUsername)}`,
        );
        if (usernameAvailabilityRequestId.current === thisRequestId) setUsernameAvailable(result.available);
      } catch {
        // Advisory only — see submitUsernameChange's own server-side check.
      } finally {
        if (usernameAvailabilityRequestId.current === thisRequestId) setCheckingUsernameAvailability(false);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [normalizedNewUsername, newUsernameValidation.valid, isCurrentUsername]);

  async function submitUsernameChange() {
    setUsernameChangeError(null);
    if (!newUsernameValidation.valid) {
      setUsernameChangeError(newUsernameValidation.error ?? 'Enter a valid username.');
      return;
    }
    if (isCurrentUsername) {
      setUsernameChangeError('That is already your username.');
      return;
    }
    setUsernameChangeState('saving');
    try {
      // The server re-validates the cooldown, re-validates the format,
      // and re-checks uniqueness against the live table — this call
      // succeeding IS the confirmation; nothing above was more than a
      // head start on the same checks.
      const result = await api<{ username: string; nextUsernameChangeAllowedAt: string }>('/api/auth/username', {
        method: 'PATCH',
        body: { username: normalizedNewUsername },
      });
      await setConfirmedUsername(result.username, result.nextUsernameChangeAllowedAt);
      setUsernameChangeState('saved');
      setNewUsernameInput('');
      setTimeout(() => {
        setUsernameChangeState('idle');
        setShowChangeUsername(false);
      }, 1500);
    } catch (e) {
      setUsernameChangeState('idle');
      setUsernameChangeError(e instanceof ApiError ? e.message : "Couldn't change your username. Please try again.");
    }
  }

  // --- Change password: re-authentication is the current password
  // itself, verified server-side in AuthService.changePassword — this
  // form cannot succeed just because the person has a valid access
  // token, by design. ---
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [passwordChangeState, setPasswordChangeState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [passwordChangeError, setPasswordChangeError] = useState<string | null>(null);

  async function submitPasswordChange() {
    setPasswordChangeError(null);
    if (newPassword.length < 12) {
      setPasswordChangeError('New password must be at least 12 characters.');
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setPasswordChangeError("New passwords don't match.");
      return;
    }
    setPasswordChangeState('saving');
    try {
      // Server re-verifies currentPassword against the stored hash
      // before writing anything — this request succeeding IS the
      // confirmation; nothing here is optimistic.
      await api('/api/auth/password', { method: 'PATCH', body: { currentPassword, newPassword } });
      setPasswordChangeState('saved');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmNewPassword('');
      setTimeout(() => {
        setPasswordChangeState('idle');
        setShowChangePassword(false);
      }, 1500);
    } catch (e) {
      setPasswordChangeState('idle');
      // The server's own message ("Current password is incorrect") is
      // already generic enough not to confirm/deny anything about the
      // account beyond what the person just typed — no need to mask it
      // further here.
      setPasswordChangeError(e instanceof ApiError ? e.message : "Couldn't change your password. Please try again.");
    }
  }

  // --- Delete account: explicit destructive confirmation + the current
  // password, both required before the server (which independently
  // re-verifies the password — see AuthService.deleteAccount, already
  // correct before this change) will act. ---
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function submitDeleteAccount() {
    setDeleteError(null);
    if (deleteConfirmText.trim().toUpperCase() !== 'DELETE') {
      setDeleteError('Type DELETE to confirm.');
      return;
    }
    setDeleting(true);
    try {
      await api('/api/auth/account', { method: 'DELETE', body: { password: deletePassword } });
      await logout(); // clears local state and redirects to /login; tolerant of the session already being gone server-side
    } catch (e) {
      setDeleting(false);
      setDeleteError(e instanceof ApiError ? e.message : "Couldn't delete your account. Please try again.");
    }
  }

  async function saveAppLockPin() {
    if (appLockPin.length < 4 || pendingAction) return;
    setSaveError(null);
    setPendingAction('appLockPin');
    try {
      const verifier = await hashLocalSecret(appLockPin);
      await idbSet('appLock:verifier', verifier);
      await setAppLockEnabled(true);
      await setAppLockTimeoutSeconds(appLockTimeout);
      await recordActivity(); // don't immediately re-lock the screen you just set this from
      await updateSettings({ appLockEnabled: true, appLockTimeoutSeconds: appLockTimeout });
      setAppLockPin('');
    } catch {
      setSaveError('Could not enable app lock. Please try again.');
    } finally {
      setPendingAction(null);
    }
  }

  async function disableAppLock() {
    if (pendingAction) return;
    setSaveError(null);
    setPendingAction('appLockDisable');
    try {
      await setAppLockEnabled(false);
      await updateSettings({ appLockEnabled: false });
    } catch {
      setSaveError('Could not disable app lock. Please try again.');
    } finally {
      setPendingAction(null);
    }
  }

  async function revokeSession(id: string) {
    if (pendingAction) return;
    setPendingAction(`revoke:${id}`);
    try {
      await api(`/api/auth/sessions/${id}`, { method: 'DELETE' });
    } catch {
      setSaveError('Could not log out that device. Please try again.');
      setPendingAction(null);
      return;
    }
    setSessions((prev) => prev.filter((s) => s.id !== id));
    setPendingAction(null);
  }

  async function revokeOtherSessions() {
    if (pendingAction) return;
    setPendingAction('revokeOthers');
    try {
      await api('/api/auth/sessions/revoke-others', { method: 'POST' });
    } catch {
      setSaveError('Could not log out other devices. Please try again.');
      setPendingAction(null);
      return;
    }
    setSessions((prev) => prev.filter((s) => s.isCurrentDevice));
    setPendingAction(null);
  }

  if (!settings) {
    return (
      <main className="flex min-h-screen flex-col p-4 pb-24 lg:pb-8 lg:pl-56">
        <div className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-3 text-center">
          {loadError ? (
            <>
              <p className="text-sm text-ink-dim">Couldn&apos;t load settings. Check your connection.</p>
              <button onClick={loadSettings} className="text-xs font-semibold text-info">
                Try again
              </button>
            </>
          ) : (
            <p className="text-sm text-ink-dim">Loading settings…</p>
          )}
        </div>
        <TabBar active="Settings" />
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col p-4 pb-24 lg:pb-8 lg:pl-56">
      <div className="mx-auto flex w-full max-w-md flex-col gap-5 md:max-w-xl lg:max-w-3xl">
        <header className="px-1 py-2 text-[17px] font-bold">Settings</header>

        {saveError ? (
          <div className="flex items-center justify-between rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
            <span>{saveError}</span>
            <button onClick={retryLastChange} className="font-semibold underline">
              Retry
            </button>
          </div>
        ) : saveState === 'saving' ? (
          <div className="px-1 text-xs text-ink-dim">Saving…</div>
        ) : saveState === 'saved' ? (
          <div className="px-1 text-xs text-ink-dim">Saved</div>
        ) : null}

        {/* Same Section components, same content, same order as before —
            below lg this is just a single column (gap-5 on the parent);
            at lg+ it becomes a 2-column grid so Settings doesn't stay an
            oddly narrow strip on a wide screen. Sections don't share
            heights, so this is a simple left-to-right/top-to-bottom flow
            rather than true masonry, which is enough for six roughly
            similar-sized cards and far simpler than the alternative. */}
        <div className="flex flex-col gap-5 lg:grid lg:grid-cols-2 lg:items-start lg:gap-4">
          <Section title="Account">
        {username && (
          <>
            <div className="text-xs text-ink-dim">Username</div>
            <div className="mb-2 break-all rounded-lg bg-surface-2 p-2 font-mono text-xs">@{username}</div>

            {!showChangeUsername ? (
              <>
                <Button variant="ghost" className="mb-3 w-full" onClick={() => setShowChangeUsername(true)} disabled={cooldownActive}>
                  Change username
                </Button>
                {cooldownActive && (
                  <p className="-mt-2 mb-3 text-xs text-ink-dim">You can change your username again on {cooldownDateLabel}.</p>
                )}
              </>
            ) : (
              <div className="mb-3 flex flex-col gap-2">
                <div className="relative">
                  <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-xs text-ink-dim">@</span>
                  <NeoInput
                    type="text"
                    placeholder="new-username"
                    value={newUsernameInput}
                    onChange={(e) => setNewUsernameInput(e.target.value)}
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    className="pl-7 text-xs"
                  />
                </div>
                {newUsernameInput.length > 0 && (
                  <div className={`text-xs ${!newUsernameValidation.valid || usernameAvailable === false ? 'text-danger' : 'text-ink-dim'}`}>
                    {!newUsernameValidation.valid
                      ? newUsernameValidation.error
                      : isCurrentUsername
                        ? 'This is already your username.'
                        : checkingUsernameAvailability
                          ? 'Checking availability…'
                          : usernameAvailable === false
                            ? 'Username is already taken'
                            : usernameAvailable === true
                              ? 'Username is available'
                              : '\u00A0'}
                  </div>
                )}
                {usernameChangeError && <div className="text-xs text-danger">{usernameChangeError}</div>}
                {usernameChangeState === 'saved' && <div className="text-xs text-ink-dim">Username updated.</div>}
                <div className="flex gap-2">
                  <Button
                    variant="raised"
                    className="flex-1"
                    onClick={submitUsernameChange}
                    disabled={usernameChangeState === 'saving' || !newUsernameValidation.valid || isCurrentUsername}
                  >
                    {usernameChangeState === 'saving' ? 'Saving…' : 'Save'}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setShowChangeUsername(false);
                      setNewUsernameInput('');
                      setUsernameChangeError(null);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
        <div className="text-xs text-ink-dim">Account ID</div>
        <div className="mb-3 break-all rounded-lg bg-surface-2 p-2 font-mono text-xs">{userId}</div>
        <Button variant="ghost" accent="danger" className="w-full" onClick={logout}>
          Log out
        </Button>
      </Section>

      <Section title="Account security">
        <Button variant="raised" className="w-full" onClick={() => setShowChangePassword((v) => !v)}>
          {showChangePassword ? 'Cancel' : 'Change password'}
        </Button>
        {showChangePassword && (
          <div className="mt-3 flex flex-col gap-2">
            <NeoInput
              type="password"
              placeholder="Current password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
            />
            <NeoInput
              type="password"
              placeholder="New password (12+ characters)"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
            />
            <NeoInput
              type="password"
              placeholder="Confirm new password"
              value={confirmNewPassword}
              onChange={(e) => setConfirmNewPassword(e.target.value)}
              autoComplete="new-password"
            />
            {passwordChangeError && <div className="text-xs text-danger">{passwordChangeError}</div>}
            {passwordChangeState === 'saved' && <div className="text-xs text-ink-dim">Password changed.</div>}
            <Button
              variant="raised"
              className="w-full"
              onClick={submitPasswordChange}
              disabled={passwordChangeState === 'saving' || !currentPassword || !newPassword}
            >
              {passwordChangeState === 'saving' ? 'Changing password…' : 'Confirm change'}
            </Button>
          </div>
        )}

        <Button variant="ghost" accent="danger" className="mt-3 w-full" onClick={() => setShowDeleteAccount((v) => !v)}>
          {showDeleteAccount ? 'Cancel' : 'Delete account'}
        </Button>
        {showDeleteAccount && (
          <div className="mt-3 flex flex-col gap-2 rounded-lg bg-danger/10 p-3">
            <p className="text-xs text-danger">
              This permanently deletes your account and every conversation you&apos;re part of. This cannot be undone.
            </p>
            <NeoInput
              type="password"
              placeholder="Current password"
              value={deletePassword}
              onChange={(e) => setDeletePassword(e.target.value)}
              autoComplete="current-password"
            />
            <NeoInput
              type="text"
              placeholder='Type "DELETE" to confirm'
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              autoComplete="off"
            />
            {deleteError && <div className="text-xs text-danger">{deleteError}</div>}
            <Button variant="raised" accent="danger" className="w-full" onClick={submitDeleteAccount} disabled={deleting || !deletePassword}>
              {deleting ? 'Deleting account…' : 'Permanently delete my account'}
            </Button>
          </div>
        )}
      </Section>

      <Section title="Devices & Sessions">
        <div className="mb-3 flex flex-col gap-3">
          {sessions.map((s) => (
            <NeoSurface key={s.id} variant="pressed" className="p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${s.online ? 'bg-positive' : 'bg-ink-dim'}`} />
                    <span className="truncate">{s.deviceName || 'Unnamed device'}</span>
                    {s.isCurrentDevice && (
                      <span className="shrink-0 rounded-full bg-info/15 px-2 py-0.5 text-[10px] font-semibold text-info">
                        This device
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-xs text-ink-dim">
                    {formatPlatform(s.platform)}
                    {formatBrowserOs(s.userAgent) ? ` · ${formatBrowserOs(s.userAgent)}` : ''}
                  </div>
                  <div className="mt-1 text-xs text-ink-dim">{s.online ? 'Online now' : `Last active ${formatWhen(s.lastSeenAt)}`}</div>
                  <div className="text-xs text-ink-dim">Logged in {formatWhen(s.createdAt)}</div>
                </div>
                {!s.isCurrentDevice && (
                  <Button
                    variant="ghost"
                    accent="danger"
                    className="!px-3 !py-1.5 text-xs"
                    onClick={() => revokeSession(s.id)}
                    disabled={pendingAction === `revoke:${s.id}`}
                  >
                    {pendingAction === `revoke:${s.id}` ? 'Logging out…' : 'Log out'}
                  </Button>
                )}
              </div>
            </NeoSurface>
          ))}
          {sessions.length === 0 && <p className="text-xs text-ink-dim">No active sessions.</p>}
        </div>
        {sessions.some((s) => !s.isCurrentDevice) && (
          <Button variant="raised" accent="danger" className="w-full" onClick={revokeOtherSessions} disabled={pendingAction === 'revokeOthers'}>
            {pendingAction === 'revokeOthers' ? 'Logging out other devices…' : 'Log out all other devices'}
          </Button>
        )}
        <p className="mt-2 text-xs text-ink-dim">
          Online status and remote log-out apply as long as this server runs as a single process — see the project docs
          for what a multi-instance deployment would need to add.
        </p>
      </Section>

      <Section title="Privacy">
        <Toggle label="Read receipts" checked={settings.readReceiptsEnabled} onChange={(v) => updateSettings({ readReceiptsEnabled: v })} />
        <Toggle label="Typing indicator" checked={settings.typingIndicatorEnabled} onChange={(v) => updateSettings({ typingIndicatorEnabled: v })} />
        <Toggle
          label="Show message content in notifications"
          checked={settings.notificationContentVisible}
          onChange={(v) => updateSettings({ notificationContentVisible: v })}
        />
        <Toggle
          label="Find me by username"
          checked={settings.usernameSearchEnabled}
          onChange={(v) => updateSettings({ usernameSearchEnabled: v })}
        />
        <p className="mt-1 text-xs text-ink-dim">
          Allow people to find you and start a new chat using your username. Turning this off doesn&apos;t affect chats
          you already have.
        </p>
      </Section>

      <Section title="App lock">
        <NeoInput type="password" inputMode="numeric" placeholder="4+ digit PIN" value={appLockPin} onChange={(e) => setAppLockPin(e.target.value)} className="mb-2" />
        <div className="mb-2">
          <div className="mb-1.5 text-xs text-ink-dim">Lock after inactivity</div>
          <div className="flex flex-wrap gap-2">
            {APP_LOCK_TIMEOUT_OPTIONS.map((opt) => (
              <button
                key={opt.seconds}
                type="button"
                onClick={() => setAppLockTimeout(opt.seconds)}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
                  appLockTimeout === opt.seconds ? 'neo-pressed text-ink' : 'neo-raised text-ink-dim'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <Button variant="raised" className="w-full" onClick={saveAppLockPin} disabled={pendingAction === 'appLockPin'}>
          {pendingAction === 'appLockPin' ? 'Saving…' : settings.appLockEnabled ? 'Update PIN' : 'Enable app lock'}
        </Button>
        {settings.appLockEnabled && (
          <Button variant="ghost" accent="danger" className="mt-2 w-full" onClick={disableAppLock} disabled={pendingAction === 'appLockDisable'}>
            {pendingAction === 'appLockDisable' ? 'Disabling…' : 'Disable app lock'}
          </Button>
        )}
        <p className="mt-2 text-xs text-ink-dim">
          Web can lock the app behind this PIN, but cannot prevent someone with OS-level access to an unlocked
          computer from reading browser data directly — that protection is Android-only (Keystore-backed), planned
          for a later phase.
        </p>
      </Section>

      <Section title="Appearance — Color customization">
        <div className="flex flex-wrap gap-2">
          {ACCENT_OPTIONS.map((opt) => (
            <button
              key={opt.label}
              onClick={() => updateSettings({ accentColor: opt.value })}
              className={`rounded-full px-3 py-2 text-xs font-semibold ${settings.accentColor === opt.value ? 'neo-pressed text-ink' : 'neo-raised text-ink-dim'}`}
              style={opt.value ? { color: opt.value } : undefined}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </Section>
        </div>
      </div>

      <TabBar active="Settings" />
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <NeoSurface variant="raised" className="p-4">
      <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-dim">{title}</div>
      {children}
    </NeoSurface>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm">{label}</span>
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`h-6 w-11 rounded-full p-0.5 transition-colors ${checked ? 'bg-positive' : 'neo-pressed'}`}
      >
        <span className={`block h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : ''}`} />
      </button>
    </div>
  );
}

/** Best-effort only — there's no npm-installed UA-parsing library available, so this recognizes the common cases and says nothing rather than guessing on the rest. */
function formatBrowserOs(userAgent: string | null): string {
  if (!userAgent) return '';
  const browser = userAgent.match(/Edg\//)
    ? 'Edge'
    : userAgent.match(/Chrome\//) && !userAgent.match(/Chromium\//)
      ? 'Chrome'
      : userAgent.match(/Firefox\//)
        ? 'Firefox'
        : userAgent.match(/Safari\//) && !userAgent.match(/Chrome\//)
          ? 'Safari'
          : null;
  const os = userAgent.match(/Windows/)
    ? 'Windows'
    : userAgent.match(/Mac OS X/)
      ? 'macOS'
      : userAgent.match(/Android/)
        ? 'Android'
        : userAgent.match(/iPhone|iPad/)
          ? 'iOS'
          : userAgent.match(/Linux/)
            ? 'Linux'
            : null;
  return [browser, os].filter(Boolean).join(' on ');
}

function formatPlatform(platform: string): string {
  return platform === 'ANDROID' ? 'Android' : 'Web';
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.round(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return date.toLocaleDateString();
}
