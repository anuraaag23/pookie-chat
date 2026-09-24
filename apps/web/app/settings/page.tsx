'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { NeoSurface } from '@/components/ui/NeoSurface';
import { NeoInput } from '@/components/ui/NeoInput';
import { AppHeader } from '@/components/navigation/AppHeader';
import { TabBar } from '@/components/chat/TabBar';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { useTheme } from '@/lib/theme/ThemeContext';
import { useAuth } from '@/lib/auth/AuthContext';
import { api, ApiError } from '@/lib/api/client';
import {
  setAppLockEnabled,
  setAppLockTimeoutSeconds,
  getAppLockTimeoutSeconds,
  setAppLocked,
  recordActivity,
  setAppLockVerifier,
  hasAppLockVerifier,
  changeAppLockPin,
  disableAppLockWithPin,
} from '@/lib/applock/state';
import { hashLocalSecret } from '@/lib/localauth/localSecret';
import { normalizeUsername, validateUsername } from '@/lib/username';
import { ThemedErrorState } from '@/components/ui/ThemedErrorState';

const DEVELOPER_PORTAL_URL = process.env.NEXT_PUBLIC_DEVELOPER_PORTAL_URL || 'https://developer.pookie.chat';

const ACCENT_OPTIONS: { label: string; value: string | null; hex: string }[] = [
  { label: 'Default (Blue)', value: null, hex: '#3B82F6' },
  { label: 'Violet', value: '#8B5CF6', hex: '#8B5CF6' },
  { label: 'Pink', value: '#EC4899', hex: '#EC4899' },
  { label: 'Amber', value: '#F59E0B', hex: '#F59E0B' },
  { label: 'Teal', value: '#14B8A6', hex: '#14B8A6' },
];

const APP_LOCK_TIMEOUT_OPTIONS: { label: string; seconds: number }[] = [
  { label: 'Immediately', seconds: 0 },
  { label: '30s', seconds: 30 },
  { label: '1 min', seconds: 60 },
  { label: '5 min', seconds: 300 },
  { label: '15 min', seconds: 900 },
];

type SettingsCategory =
  | 'account'
  | 'security'
  | 'privacy'
  | 'applock'
  | 'sessions'
  | 'appearance'
  | 'storage'
  | 'legal';

interface Settings {
  readReceiptsEnabled: boolean;
  typingIndicatorEnabled: boolean;
  notificationContentVisible: boolean;
  accentColor: string | null;
  appLockEnabled: boolean;
  appLockTimeoutSeconds: number;
  screenshotProtectionEnabled: boolean;
  usernameSearchEnabled: boolean;
  attachmentStorageProvider?: 'MANAGED' | 'GOOGLE_DRIVE';
}

interface GoogleDriveStatus {
  configured: boolean;
  connected: boolean;
  revoked: boolean;
  folderId: string | null;
  folderUrl: string | null;
  provider: 'MANAGED' | 'GOOGLE_DRIVE';
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
  const { theme, setAccentColor } = useTheme();
  const router = useRouter();

  // Navigation state
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>('account');
  const [mobileViewingCategory, setMobileViewingCategory] = useState(false);

  // Settings state
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [lastFailedPatch, setLastFailedPatch] = useState<Partial<Settings> | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  // Sessions & Drive state
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [driveStatus, setDriveStatus] = useState<GoogleDriveStatus | null>(null);
  const [driveStatusError, setDriveStatusError] = useState<'network' | 'unauthorized' | null>(null);
  const [driveActionError, setDriveActionError] = useState<string | null>(null);
  const [connectingDrive, setConnectingDrive] = useState(false);
  const [disconnectingDrive, setDisconnectingDrive] = useState(false);

  // App Lock state
  const [hasVerifier, setHasVerifier] = useState(false);
  const [appLockTimeout, setAppLockTimeout] = useState(60);
  const [appLockFeedback, setAppLockFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const appLockFeedbackTimerRef = useRef<NodeJS.Timeout | null>(null);

  // App Lock setup state (first-time)
  const [newSetupPin, setNewSetupPin] = useState('');
  const [confirmSetupPin, setConfirmSetupPin] = useState('');

  // App Lock change PIN modal state
  const [showChangePinModal, setShowChangePinModal] = useState(false);
  const [changeOldPin, setChangeOldPin] = useState('');
  const [changeNewPin, setChangeNewPin] = useState('');
  const [changeConfirmPin, setChangeConfirmPin] = useState('');
  const [changePinError, setChangePinError] = useState<string | null>(null);
  const [changingPin, setChangingPin] = useState(false);

  // App Lock disable modal state
  const [showDisableModal, setShowDisableModal] = useState(false);
  const [disablePin, setDisablePin] = useState('');
  const [disableError, setDisableError] = useState<string | null>(null);
  const [disabling, setDisabling] = useState(false);

  // Change password state
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [passwordChangeState, setPasswordChangeState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [passwordChangeError, setPasswordChangeError] = useState<string | null>(null);

  // Change username state
  const [showChangeUsername, setShowChangeUsername] = useState(false);
  const [newUsernameInput, setNewUsernameInput] = useState('');
  const [usernameAvailable, setUsernameAvailable] = useState<boolean | null>(null);
  const [checkingUsernameAvailability, setCheckingUsernameAvailability] = useState(false);
  const [usernameChangeState, setUsernameChangeState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [usernameChangeError, setUsernameChangeError] = useState<string | null>(null);

  // Delete account state
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Logout confirm modal state
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  // Escape key handler
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setShowLogoutConfirm(false);
        setShowDisableModal(false);
        setShowChangePinModal(false);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  function loadSettings() {
    setLoadError(false);
    api<Settings>('/api/settings')
      .then((data) => {
        setSettings(data);
        if (typeof data.appLockTimeoutSeconds === 'number') {
          setAppLockTimeout(data.appLockTimeoutSeconds);
        }
        if (data.accentColor !== undefined) {
          setAccentColor(data.accentColor);
        }
      })
      .catch(() => setLoadError(true));
  }

  function loadDriveStatus() {
    setDriveStatusError(null);
    setDriveActionError(null);
    api<GoogleDriveStatus>('/api/storage/google-drive/status')
      .then((status) => {
        setDriveStatus(status);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          setDriveStatusError('unauthorized');
        } else {
          setDriveStatusError('network');
        }
      });
  }

  function refreshSessions() {
    api<SessionEntry[]>('/api/auth/sessions').then(setSessions).catch(() => {});
  }

  // Load initial settings, sessions, drive, and App Lock verifier presence
  useEffect(() => {
    loadSettings();
    loadDriveStatus();
    refreshSessions();
    const interval = setInterval(refreshSessions, 15_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!userId) return;
    hasAppLockVerifier(userId).then(setHasVerifier).catch(() => {});
    getAppLockTimeoutSeconds(userId).then((t) => setAppLockTimeout(t)).catch(() => {});
  }, [userId]);

  async function updateSettings(patch: Partial<Settings>) {
    if (!settings) return;
    const previous = settings;
    const next = { ...settings, ...patch };
    setSettings(next);
    if ('accentColor' in patch) {
      setAccentColor(patch.accentColor ?? null);
    }
    setSaveError(null);
    setLastFailedPatch(null);
    setSaveState('saving');
    try {
      await api('/api/settings', { method: 'PATCH', body: patch });
      setSaveState('saved');
      setTimeout(() => setSaveState((s) => (s === 'saved' ? 'idle' : s)), 2000);
    } catch {
      setSettings(previous);
      if ('accentColor' in patch) {
        setAccentColor(previous.accentColor ?? null);
      }
      setSaveState('idle');
      setSaveError("Couldn't save that change.");
      setLastFailedPatch(patch);
    }
  }

  // App Lock actions
  async function selectAppLockTimeout(seconds: number) {
    setAppLockTimeout(seconds);
    await setAppLockTimeoutSeconds(seconds, userId);
    if (settings?.appLockEnabled) {
      setSaveError(null);
      try {
        await updateSettings({ appLockTimeoutSeconds: seconds });
      } catch {
        setSaveError('Could not update lock timeout. Please try again.');
      }
    }
  }

  async function handleInitialEnableAppLock() {
    if (pendingAction) return;
    if (newSetupPin.length < 4) {
      triggerAppLockFeedback('error', 'PIN must be at least 4 digits.');
      return;
    }
    if (newSetupPin !== confirmSetupPin) {
      triggerAppLockFeedback('error', 'PINs do not match.');
      return;
    }

    setPendingAction('appLockSetup');
    try {
      const verifier = await hashLocalSecret(newSetupPin);
      await setAppLockVerifier(verifier, userId);
      await setAppLockEnabled(true, userId);
      await setAppLockTimeoutSeconds(appLockTimeout, userId);
      await setAppLocked(false, userId);
      await recordActivity(userId);
      await updateSettings({ appLockEnabled: true, appLockTimeoutSeconds: appLockTimeout });
      setHasVerifier(true);
      setNewSetupPin('');
      setConfirmSetupPin('');
      triggerAppLockFeedback('success', 'App Lock enabled successfully.');
    } catch {
      triggerAppLockFeedback('error', 'Could not enable App Lock. Please try again.');
    } finally {
      setPendingAction(null);
    }
  }

  async function handleChangePinSubmit(e: React.FormEvent) {
    e.preventDefault();
    setChangePinError(null);
    if (!changeOldPin) {
      setChangePinError('Current PIN is required.');
      return;
    }
    if (changeNewPin.length < 4) {
      setChangePinError('New PIN must be at least 4 digits.');
      return;
    }
    if (changeNewPin !== changeConfirmPin) {
      setChangePinError('New PINs do not match.');
      return;
    }
    if (changeOldPin === changeNewPin) {
      setChangePinError('New PIN must be different from current PIN.');
      return;
    }

    setChangingPin(true);
    try {
      const res = await changeAppLockPin(changeOldPin, changeNewPin, userId);
      if (!res.success) {
        setChangePinError(res.error || 'Could not change PIN.');
        return;
      }
      setShowChangePinModal(false);
      setChangeOldPin('');
      setChangeNewPin('');
      setChangeConfirmPin('');
      triggerAppLockFeedback('success', 'PIN updated successfully.');
    } catch {
      setChangePinError('Could not change PIN. Please try again.');
    } finally {
      setChangingPin(false);
    }
  }

  async function handleDisableAppLockSubmit(e: React.FormEvent) {
    e.preventDefault();
    setDisableError(null);
    if (!disablePin) {
      setDisableError('Current PIN is required to disable App Lock.');
      return;
    }

    setDisabling(true);
    try {
      const res = await disableAppLockWithPin(disablePin, userId);
      if (!res.success) {
        setDisableError(res.error || 'Incorrect PIN.');
        return;
      }
      await updateSettings({ appLockEnabled: false });
      setShowDisableModal(false);
      setDisablePin('');
      triggerAppLockFeedback('success', 'App Lock disabled.');
    } catch {
      setDisableError('Could not disable App Lock. Please try again.');
    } finally {
      setDisabling(false);
    }
  }

  function triggerAppLockFeedback(type: 'success' | 'error', message: string) {
    if (appLockFeedbackTimerRef.current) clearTimeout(appLockFeedbackTimerRef.current);
    setAppLockFeedback({ type, message });
    appLockFeedbackTimerRef.current = setTimeout(() => setAppLockFeedback(null), 3500);
  }

  // Username change handling
  const normalizedNewUsername = normalizeUsername(newUsernameInput);
  const newUsernameValidation = validateUsername(normalizedNewUsername);
  const isCurrentUsername = username !== null && normalizedNewUsername === username;
  const cooldownActive = !!nextUsernameChangeAllowedAt && new Date(nextUsernameChangeAllowedAt) > new Date();

  let cooldownDateLabel: string | null = null;
  if (nextUsernameChangeAllowedAt) {
    try {
      const d = new Date(nextUsernameChangeAllowedAt);
      if (!isNaN(d.getTime())) {
        cooldownDateLabel = new Intl.DateTimeFormat('en-US', {
          month: 'long',
          day: 'numeric',
          year: 'numeric',
        }).format(d);
      }
    } catch {}
  }

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
    if (cooldownActive) {
      setUsernameChangeError(
        cooldownDateLabel
          ? `Username changes are limited to once every 90 days. Next change available on ${cooldownDateLabel}.`
          : 'Username changes are limited to once every 90 days.',
      );
      return;
    }
    setUsernameChangeState('saving');
    try {
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

  // Password change handling
  async function submitPasswordChange() {
    setPasswordChangeError(null);
    if (newPassword.length < 8) {
      setPasswordChangeError('New password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setPasswordChangeError("New passwords don't match.");
      return;
    }
    setPasswordChangeState('saving');
    try {
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
      setPasswordChangeError(e instanceof ApiError ? e.message : "Couldn't change your password. Please try again.");
    }
  }

  // Account deletion handling
  async function submitDeleteAccount() {
    setDeleteError(null);
    if (deleteConfirmText.trim().toUpperCase() !== 'DELETE') {
      setDeleteError('Type DELETE to confirm.');
      return;
    }
    setDeleting(true);
    try {
      await api('/api/auth/account', { method: 'DELETE', body: { password: deletePassword } });
      await logout();
    } catch (e) {
      setDeleting(false);
      setDeleteError(e instanceof ApiError ? e.message : "Couldn't delete your account. Please try again.");
    }
  }

  // Session revocation
  async function revokeSession(id: string) {
    if (pendingAction) return;
    setPendingAction(`revoke:${id}`);
    try {
      await api(`/api/auth/sessions/${id}`, { method: 'DELETE' });
      setSessions((prev) => prev.filter((s) => s.id !== id));
    } catch {
      setSaveError('Could not log out that device. Please try again.');
    } finally {
      setPendingAction(null);
    }
  }

  async function revokeOtherSessions() {
    if (pendingAction) return;
    setPendingAction('revokeOthers');
    try {
      await api('/api/auth/sessions/revoke-others', { method: 'POST' });
      setSessions((prev) => prev.filter((s) => s.isCurrentDevice));
    } catch {
      setSaveError('Could not log out other devices. Please try again.');
    } finally {
      setPendingAction(null);
    }
  }

  // Drive OAuth connect/disconnect
  async function connectGoogleDrive() {
    setConnectingDrive(true);
    setDriveActionError(null);
    try {
      const res = await api<{ url?: string; authUrl?: string }>('/api/storage/google-drive/connect');
      const targetUrl = res.authUrl || res.url;
      if (targetUrl) {
        window.location.href = targetUrl;
      } else {
        setDriveActionError('Google Drive connection is currently unavailable.');
      }
    } catch (e) {
      setConnectingDrive(false);
      if (e instanceof ApiError && e.status === 401) {
        setDriveActionError('Your session has expired. Please sign in again.');
      } else if (e instanceof ApiError && e.status === 400) {
        setDriveActionError('Google Drive connection is temporarily unavailable due to server configuration.');
      } else {
        setDriveActionError(e instanceof ApiError ? e.message : 'Could not initiate Google Drive connection.');
      }
    }
  }

  async function disconnectGoogleDrive() {
    setDisconnectingDrive(true);
    setDriveActionError(null);
    try {
      await api('/api/storage/google-drive/disconnect', { method: 'POST' });
      loadDriveStatus();
    } catch (e) {
      setDriveActionError(e instanceof ApiError ? e.message : 'Could not disconnect Google Drive.');
    } finally {
      setDisconnectingDrive(false);
    }
  }

  if (!settings) {
    return (
      <div className="flex min-h-screen flex-col bg-surface">
        <AppHeader activeTab="Settings" />
        <main className="flex flex-1 flex-col items-center justify-center p-4 pb-24 md:pb-8">
          <div className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-3 text-center">
            {loadError ? (
              <ThemedErrorState
                compact
                category="backend-unavailable"
                title="Couldn't load settings"
                message="Check your connection and try again."
                onRetry={loadSettings}
              />
            ) : (
              <div className="text-xs text-ink-dim animate-pulse">Loading settings…</div>
            )}
          </div>
        </main>
        <TabBar active="Settings" />
      </div>
    );
  }

  // Categories configuration with icons
  const CATEGORIES: { id: SettingsCategory; label: string; icon: React.ReactNode; desc: string }[] = [
    {
      id: 'account',
      label: 'Account',
      desc: 'Username, email, and identity',
      icon: (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </svg>
      ),
    },
    {
      id: 'security',
      label: 'Security',
      desc: 'Password, security status, and credentials',
      icon: (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
      ),
    },
    {
      id: 'privacy',
      label: 'Privacy',
      desc: 'Discovery, receipts, and indicators',
      icon: (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      ),
    },
    {
      id: 'applock',
      label: 'App Lock',
      desc: 'PIN security and auto-lock timeouts',
      icon: (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      ),
    },
    {
      id: 'sessions',
      label: 'Devices & Sessions',
      desc: 'Active logins and device management',
      icon: (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
          <line x1="12" y1="18" x2="12.01" y2="18" />
        </svg>
      ),
    },
    {
      id: 'appearance',
      label: 'Appearance',
      desc: 'Theme mode and accent colors',
      icon: (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 2a7 7 0 0 0 0 14 7 7 0 0 0 0-14z" />
        </svg>
      ),
    },
    {
      id: 'storage',
      label: 'Storage & Drive',
      desc: 'Attachment hosting & Google Drive',
      icon: (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
        </svg>
      ),
    },
    {
      id: 'legal',
      label: 'Help & Legal',
      desc: 'Terms, privacy policy, and support',
      icon: (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      ),
    },
  ];

  const appLockIsConfigured = !!settings.appLockEnabled && hasVerifier;

  return (
    <div className="flex min-h-screen flex-col bg-surface">
      <AppHeader activeTab="Settings" />

      <main className="flex flex-1 flex-col px-4 py-6 pb-24 md:pb-8">
        <div className="mx-auto w-full max-w-5xl">
          {/* Header title */}
          <div className="mb-6 flex items-center justify-between">
            <div>
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-ink">Settings</h1>
              <p className="mt-0.5 text-xs text-ink-dim">Manage your account, privacy, security, and preferences</p>
            </div>
            {saveState === 'saving' && (
              <span className="text-xs text-ink-dim animate-pulse">Saving changes…</span>
            )}
            {saveState === 'saved' && (
              <span className="text-xs text-accent font-semibold flex items-center gap-1">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                Saved
              </span>
            )}
            {saveError && (
              <span className="text-xs text-danger font-semibold flex items-center gap-1">
                {saveError}
              </span>
            )}
          </div>

          {/* Desktop Dual-Pane & Mobile View */}
          <div className="md:grid md:grid-cols-12 md:gap-6 items-start">
            {/* Category Navigation Pane (Desktop visible; Mobile visible only when not viewing detail) */}
            <div className={`md:col-span-4 lg:col-span-4 flex flex-col gap-2 ${mobileViewingCategory ? 'hidden md:flex' : 'flex'}`}>
              <NeoSurface variant="raised" className="p-2 flex flex-col gap-1 rounded-2xl">
                {CATEGORIES.map((cat) => {
                  const isActive = activeCategory === cat.id;
                  return (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => {
                        setActiveCategory(cat.id);
                        setMobileViewingCategory(true);
                      }}
                      className={`flex items-center gap-3 p-3 rounded-xl text-left transition-all ${
                        isActive
                          ? 'bg-surface-2/80 text-ink shadow-sm ring-1 ring-info/50'
                          : 'text-ink-dim hover:text-ink hover:bg-surface-2/30'
                      }`}
                    >
                      <div className={`p-2 rounded-lg ${isActive ? 'bg-info/20 text-info' : 'bg-surface-2/50 text-ink-dim'}`}>
                        {cat.icon}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold text-ink leading-tight">{cat.label}</div>
                        <div className="text-[11px] text-ink-dim truncate leading-tight mt-0.5">{cat.desc}</div>
                      </div>
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ink-dim/40 shrink-0">
                        <polyline points="9 18 15 12 9 6" />
                      </svg>
                    </button>
                  );
                })}
              </NeoSurface>

              {/* Logout button at bottom of navigation */}
              <Button
                variant="raised"
                accent="danger"
                className="w-full mt-2 justify-center gap-2 font-semibold text-xs py-3"
                onClick={() => setShowLogoutConfirm(true)}
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
                Log Out
              </Button>
            </div>

            {/* Category Detail Pane (Desktop visible; Mobile visible when viewing detail) */}
            <div className={`md:col-span-8 lg:col-span-8 flex flex-col gap-4 ${mobileViewingCategory ? 'flex' : 'hidden md:flex'}`}>
              {/* Mobile Back Header */}
              <div className="md:hidden flex items-center gap-2 pb-2">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Back to settings categories"
                  className="!h-8 !w-8"
                  onClick={() => setMobileViewingCategory(false)}
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                </Button>
                <span className="text-sm font-bold text-ink">Back to Settings</span>
              </div>

              {/* SECTION: ACCOUNT */}
              {activeCategory === 'account' && (
                <div className="flex flex-col gap-4">
                  <Section title="Account Identity">
                    <div className="flex flex-col gap-3">
                      <div>
                        <div className="text-xs text-ink-dim">Username</div>
                        <div className="font-mono text-base font-semibold text-ink">
                          {username ? `@${username}` : 'None'}
                        </div>
                      </div>

                      <Button
                        variant="ghost"
                        className="w-full justify-start text-xs font-semibold"
                        onClick={() => setShowChangeUsername((v) => !v)}
                      >
                        {showChangeUsername ? 'Cancel username change' : 'Change username'}
                      </Button>

                      {showChangeUsername && (
                        <div className="flex flex-col gap-2 rounded-xl bg-surface-2/40 p-4 border border-glass-border/40">
                          <NeoInput
                            type="text"
                            placeholder="New username (3-20 characters)"
                            value={newUsernameInput}
                            onChange={(e) => setNewUsernameInput(e.target.value)}
                            autoComplete="off"
                          />
                          <p className="text-[11px] text-ink-dim">
                            3-20 characters, lowercase letters, numbers, and non-consecutive underscores.
                          </p>

                          {checkingUsernameAvailability && (
                            <div className="text-xs text-ink-dim animate-pulse">Checking availability…</div>
                          )}
                          {usernameAvailable === true && (
                            <div className="text-xs text-accent font-semibold flex items-center gap-1">
                              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                              Available
                            </div>
                          )}
                          {usernameAvailable === false && (
                            <div className="text-xs text-danger font-semibold">Username is taken</div>
                          )}
                          {usernameChangeError && (
                            <div className="text-xs text-danger font-semibold">{usernameChangeError}</div>
                          )}

                          <Button
                            variant="raised"
                            className="w-full mt-1"
                            onClick={submitUsernameChange}
                            disabled={usernameChangeState === 'saving' || !newUsernameValidation.valid || isCurrentUsername}
                          >
                            {usernameChangeState === 'saving' ? 'Saving…' : 'Confirm Username Change'}
                          </Button>
                        </div>
                      )}
                    </div>
                  </Section>

                  <Section title="Account Deletion">
                    <p className="text-xs text-ink-dim">
                      Permanently delete your account, keys, and conversation history. This cannot be undone.
                    </p>
                    <Button
                      variant="ghost"
                      accent="danger"
                      className="mt-3 w-full"
                      onClick={() => setShowDeleteAccount((v) => !v)}
                    >
                      {showDeleteAccount ? 'Cancel' : 'Delete Account'}
                    </Button>

                    {showDeleteAccount && (
                      <div className="mt-3 flex flex-col gap-3 rounded-xl bg-danger/10 p-4 border border-danger/30">
                        <p className="text-xs font-semibold text-danger">
                          Warning: This action is permanent and immediate.
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
                        {deleteError && <div className="text-xs text-danger font-semibold">{deleteError}</div>}
                        <Button
                          variant="raised"
                          accent="danger"
                          className="w-full"
                          onClick={submitDeleteAccount}
                          disabled={deleting || !deletePassword || deleteConfirmText.trim().toUpperCase() !== 'DELETE'}
                        >
                          {deleting ? 'Deleting account…' : 'Permanently Delete My Account'}
                        </Button>
                      </div>
                    )}
                  </Section>
                </div>
              )}

              {/* SECTION: SECURITY */}
              {activeCategory === 'security' && (
                <div className="flex flex-col gap-4">
                  <Section title="Password & Authentication">
                    <Button
                      variant="ghost"
                      className="w-full justify-start text-xs font-semibold"
                      onClick={() => setShowChangePassword((v) => !v)}
                    >
                      {showChangePassword ? 'Cancel password change' : 'Change password'}
                    </Button>

                    {showChangePassword && (
                      <div className="mt-3 flex flex-col gap-3 rounded-xl bg-surface-2/40 p-4 border border-glass-border/40">
                        <NeoInput
                          type="password"
                          placeholder="Current password"
                          value={currentPassword}
                          onChange={(e) => setCurrentPassword(e.target.value)}
                          autoComplete="current-password"
                        />
                        <NeoInput
                          type="password"
                          placeholder="New password (8+ characters)"
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
                        {passwordChangeError && <div className="text-xs text-danger font-semibold">{passwordChangeError}</div>}
                        {passwordChangeState === 'saved' && (
                          <div className="text-xs text-accent font-semibold flex items-center gap-1">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                            Password changed successfully
                          </div>
                        )}
                        <Button
                          variant="raised"
                          className="w-full"
                          onClick={submitPasswordChange}
                          disabled={passwordChangeState === 'saving' || !currentPassword || !newPassword}
                        >
                          {passwordChangeState === 'saving' ? 'Changing password…' : 'Confirm Password Change'}
                        </Button>
                      </div>
                    )}
                  </Section>

                  <Section title="App Lock Status">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm font-semibold text-ink">Local Device Lock</div>
                        <div className="text-xs text-ink-dim">
                          {appLockIsConfigured ? 'Enabled with PIN verifier' : 'Disabled'}
                        </div>
                      </div>
                      <Button
                        variant="glass"
                        className="text-xs font-semibold !px-3 !py-1.5"
                        onClick={() => setActiveCategory('applock')}
                      >
                        Manage App Lock
                      </Button>
                    </div>
                  </Section>

                  <Section title="Active Logins">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm font-semibold text-ink">Active Sessions</div>
                        <div className="text-xs text-ink-dim">{sessions.length} authorized device(s)</div>
                      </div>
                      <Button
                        variant="glass"
                        className="text-xs font-semibold !px-3 !py-1.5"
                        onClick={() => setActiveCategory('sessions')}
                      >
                        View Devices
                      </Button>
                    </div>
                  </Section>
                </div>
              )}

              {/* SECTION: PRIVACY */}
              {activeCategory === 'privacy' && (
                <div className="flex flex-col gap-4">
                  <Section title="Discovery">
                    <div className="flex flex-col gap-1">
                      <Toggle
                        label="Find me by username"
                        checked={settings.usernameSearchEnabled}
                        onChange={(v) => updateSettings({ usernameSearchEnabled: v })}
                      />
                      <p className="text-[11px] text-ink-dim leading-relaxed">
                        Allow other people to discover your handle in search and send conversation requests. Turning this off prevents new users from discovering your profile; existing chats remain unaffected.
                      </p>
                    </div>
                  </Section>

                  <Section title="Messaging & Chat">
                    <div className="flex flex-col gap-4">
                      <div className="flex flex-col gap-1">
                        <Toggle
                          label="Read receipts"
                          checked={settings.readReceiptsEnabled}
                          onChange={(v) => updateSettings({ readReceiptsEnabled: v })}
                        />
                        <p className="text-[11px] text-ink-dim leading-relaxed">
                          Let contacts see when you have read their messages in 1-on-1 chats.
                        </p>
                      </div>

                      <div className="flex flex-col gap-1">
                        <Toggle
                          label="Typing indicators"
                          checked={settings.typingIndicatorEnabled}
                          onChange={(v) => updateSettings({ typingIndicatorEnabled: v })}
                        />
                        <p className="text-[11px] text-ink-dim leading-relaxed">
                          Display when you are actively typing a message in active chats.
                        </p>
                      </div>
                    </div>
                  </Section>

                  <Section title="Notifications & Lock Screen">
                    <div className="flex flex-col gap-1">
                      <Toggle
                        label="Show message content in notifications"
                        checked={settings.notificationContentVisible}
                        onChange={(v) => updateSettings({ notificationContentVisible: v })}
                      />
                      <p className="text-[11px] text-ink-dim leading-relaxed">
                        When turned off, notifications show &quot;New message&quot; without displaying encrypted message text on lock screens.
                      </p>
                    </div>
                  </Section>
                </div>
              )}

              {/* SECTION: APP LOCK (HARDENED) */}
              {activeCategory === 'applock' && (
                <div className="flex flex-col gap-4">
                  <Section title="App Lock Management">
                    {appLockFeedback && (
                      <div
                        role="alert"
                        className={`mb-4 flex items-center gap-2 rounded-xl p-3 text-xs font-semibold ${
                          appLockFeedback.type === 'success'
                            ? 'bg-accent/15 text-accent border border-accent/30'
                            : 'bg-danger/15 text-danger border border-danger/30'
                        }`}
                      >
                        {appLockFeedback.type === 'success' ? (
                          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        ) : (
                          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        )}
                        <span>{appLockFeedback.message}</span>
                      </div>
                    )}

                    {appLockIsConfigured ? (
                      /* CONFIGURED STATE: Clearly show enabled, PIN set, and proper actions */
                      <div className="flex flex-col gap-4">
                        <div className="flex items-center gap-3 rounded-xl bg-accent/10 border border-accent/25 p-4">
                          <div className="p-2.5 rounded-full bg-accent/20 text-accent shrink-0">
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                            </svg>
                          </div>
                          <div>
                            <div className="text-sm font-bold text-ink">App Lock is enabled</div>
                            <div className="text-xs text-ink-dim">PIN is already set on this device.</div>
                          </div>
                        </div>

                        {/* Lock Timeout Selection (No PIN re-entry required) */}
                        <div className="flex flex-col gap-2 pt-1">
                          <div className="text-xs font-semibold text-ink">Lock after inactivity</div>
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                            {APP_LOCK_TIMEOUT_OPTIONS.map((opt) => {
                              const isSelected = appLockTimeout === opt.seconds;
                              return (
                                <button
                                  key={opt.seconds}
                                  type="button"
                                  onClick={() => selectAppLockTimeout(opt.seconds)}
                                  className={`py-2 px-3 rounded-xl text-xs font-semibold border transition-all text-center ${
                                    isSelected
                                      ? 'bg-info/20 text-info border-info/50 shadow-sm'
                                      : 'bg-surface-2/40 text-ink-dim border-glass-border/40 hover:text-ink'
                                  }`}
                                >
                                  {opt.label}
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        {/* Authenticated Actions */}
                        <div className="flex flex-col sm:flex-row gap-2.5 pt-2">
                          <Button
                            variant="glass"
                            className="flex-1 font-semibold text-xs justify-center"
                            onClick={() => {
                              setChangeOldPin('');
                              setChangeNewPin('');
                              setChangeConfirmPin('');
                              setChangePinError(null);
                              setShowChangePinModal(true);
                            }}
                          >
                            Change PIN
                          </Button>
                          <Button
                            variant="ghost"
                            accent="danger"
                            className="flex-1 font-semibold text-xs justify-center"
                            onClick={() => {
                              setDisablePin('');
                              setDisableError(null);
                              setShowDisableModal(true);
                            }}
                          >
                            Disable App Lock
                          </Button>
                        </div>
                      </div>
                    ) : (
                      /* UNCONFIGURED STATE: Set PIN flow */
                      <div className="flex flex-col gap-3">
                        <p className="text-xs text-ink-dim">
                          Require a PIN to unlock Pookie Chat on this device when returning from another app or tab.
                        </p>

                        <div className="flex flex-col gap-2.5 pt-1">
                          <NeoInput
                            type="password"
                            inputMode="numeric"
                            placeholder="Set 4+ digit PIN"
                            value={newSetupPin}
                            onChange={(e) => setNewSetupPin(e.target.value)}
                          />
                          <NeoInput
                            type="password"
                            inputMode="numeric"
                            placeholder="Confirm PIN"
                            value={confirmSetupPin}
                            onChange={(e) => setConfirmSetupPin(e.target.value)}
                          />

                          <div className="pt-1">
                            <div className="mb-1.5 text-xs text-ink-dim font-medium">Auto-lock inactivity timeout</div>
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                              {APP_LOCK_TIMEOUT_OPTIONS.map((opt) => (
                                <button
                                  key={opt.seconds}
                                  type="button"
                                  onClick={() => setAppLockTimeout(opt.seconds)}
                                  className={`py-2 px-3 rounded-xl text-xs font-semibold border transition-all text-center ${
                                    appLockTimeout === opt.seconds
                                      ? 'bg-info/20 text-info border-info/50 shadow-sm'
                                      : 'bg-surface-2/40 text-ink-dim border-glass-border/40 hover:text-ink'
                                  }`}
                                >
                                  {opt.label}
                                </button>
                              ))}
                            </div>
                          </div>

                          <Button
                            variant="raised"
                            className="w-full mt-2"
                            onClick={handleInitialEnableAppLock}
                            disabled={!newSetupPin || !confirmSetupPin || pendingAction === 'appLockSetup'}
                          >
                            {pendingAction === 'appLockSetup' ? 'Enabling App Lock…' : 'Enable App Lock'}
                          </Button>
                        </div>
                      </div>
                    )}
                  </Section>
                </div>
              )}

              {/* SECTION: DEVICES & SESSIONS */}
              {activeCategory === 'sessions' && (
                <div className="flex flex-col gap-4">
                  <Section title="Active Devices">
                    <p className="text-xs text-ink-dim mb-3">
                      Review devices currently authorized to access your account.
                    </p>

                    <div className="flex flex-col gap-2.5">
                      {sessions.map((s) => (
                        <div key={s.id} className="flex items-center justify-between p-3 rounded-xl bg-surface-2/40 border border-glass-border/40">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-semibold text-ink">
                                {s.deviceName || formatBrowserOs(s.userAgent) || formatPlatform(s.platform)}
                              </span>
                              {s.isCurrentDevice && (
                                <span className="text-[10px] font-bold text-accent px-2 py-0.5 rounded-full bg-accent/15 border border-accent/30">
                                  Current Device
                                </span>
                              )}
                              {s.online && !s.isCurrentDevice && (
                                <span className="text-[10px] font-bold text-info px-2 py-0.5 rounded-full bg-info/15 border border-info/30">
                                  Online
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-ink-dim mt-0.5">
                              {s.online ? 'Active now' : `Last seen ${formatWhen(s.lastSeenAt)}`}
                            </div>
                          </div>

                          {!s.isCurrentDevice && (
                            <Button
                              variant="ghost"
                              accent="danger"
                              className="text-xs font-semibold !px-2.5 !py-1"
                              onClick={() => revokeSession(s.id)}
                              disabled={pendingAction === `revoke:${s.id}`}
                            >
                              {pendingAction === `revoke:${s.id}` ? 'Revoking…' : 'Revoke'}
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>

                    {sessions.some((s) => !s.isCurrentDevice) && (
                      <Button
                        variant="ghost"
                        accent="danger"
                        className="w-full mt-3 font-semibold text-xs"
                        onClick={revokeOtherSessions}
                        disabled={pendingAction === 'revokeOthers'}
                      >
                        {pendingAction === 'revokeOthers' ? 'Revoking other devices…' : 'Revoke all other devices'}
                      </Button>
                    )}
                  </Section>
                </div>
              )}

              {/* SECTION: APPEARANCE */}
              {activeCategory === 'appearance' && (
                <div className="flex flex-col gap-4">
                  <Section title="Theme & Display">
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
                      <div className="flex items-center justify-between p-3.5 rounded-xl bg-surface-2/40 border border-glass-border/40">
                        <div>
                          <div className="text-sm font-semibold text-ink">Color Mode</div>
                          <div className="text-xs text-ink-dim">
                            Active: <span className="font-semibold capitalize text-ink">{theme} mode</span>
                          </div>
                        </div>
                        <ThemeToggle />
                      </div>

                      <div className="p-3.5 rounded-xl bg-surface-2/40 border border-glass-border/40">
                        <div className="text-xs font-semibold text-ink-dim mb-2.5">Accent Color</div>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                          {ACCENT_OPTIONS.map((opt) => {
                            const isSelected = settings.accentColor === opt.value;
                            return (
                              <button
                                key={opt.label}
                                type="button"
                                onClick={() => updateSettings({ accentColor: opt.value })}
                                className={`flex items-center gap-2 py-2 px-3 rounded-xl text-xs font-semibold transition-all ${
                                  isSelected
                                    ? 'neo-pressed text-ink ring-2 ring-info/50 shadow-inner'
                                    : 'neo-raised text-ink-dim hover:text-ink'
                                }`}
                              >
                                <span
                                  className="w-3.5 h-3.5 rounded-full shrink-0 shadow-sm border border-white/20 flex items-center justify-center"
                                  style={{ backgroundColor: opt.hex }}
                                >
                                  {isSelected && (
                                    <svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="#ffffff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                                      <polyline points="20 6 9 17 4 12" />
                                    </svg>
                                  )}
                                </span>
                                <span className="truncate">{opt.label}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </Section>
                </div>
              )}

              {/* SECTION: STORAGE */}
              {activeCategory === 'storage' && (
                <div className="flex flex-col gap-4">
                  <Section title="Attachment Storage">
                    <div className="flex flex-col gap-4">
                      <div>
                        <div className="text-xs text-ink-dim font-medium">Active Storage Mode</div>
                        <div className="text-sm font-bold text-ink mt-0.5 flex items-center gap-2">
                          {driveStatus?.connected ? (
                            <span className="flex items-center gap-1.5 text-positive font-bold">
                              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                              Google Drive Connected
                            </span>
                          ) : (
                            <span className="text-ink">Pookie Chat Managed Encrypted Storage</span>
                          )}
                        </div>
                      </div>

                      {/* State D: Session Expired / Unauthorized */}
                      {driveStatusError === 'unauthorized' && (
                        <div className="p-4 rounded-xl bg-danger/10 border border-danger/25 flex flex-col gap-2">
                          <div className="text-xs font-bold text-danger flex items-center gap-1.5">
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
                            Session Expired
                          </div>
                          <p className="text-xs text-ink-dim">
                            Your active session needs to be refreshed to view or modify storage settings.
                          </p>
                          <Button
                            variant="raised"
                            className="text-xs font-semibold self-start mt-1"
                            onClick={() => router.push('/login')}
                          >
                            Sign In Again
                          </Button>
                        </div>
                      )}

                      {/* State E: Network or Server Error */}
                      {driveStatusError === 'network' && (
                        <div className="p-4 rounded-xl bg-surface-2 border border-glass-border/40 flex flex-col gap-2">
                          <div className="text-xs font-bold text-ink flex items-center gap-1.5">
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
                            Connection Error
                          </div>
                          <p className="text-xs text-ink-dim">
                            Could not check Google Drive status. Please check your internet connection and try again.
                          </p>
                          <Button
                            variant="raised"
                            className="text-xs font-semibold self-start mt-1"
                            onClick={loadDriveStatus}
                          >
                            Retry Check
                          </Button>
                        </div>
                      )}

                      {/* Action error banner */}
                      {driveActionError && (
                        <div className="p-3 rounded-xl bg-danger/15 border border-danger/30 text-xs text-danger flex items-center gap-2">
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                          <span>{driveActionError}</span>
                        </div>
                      )}

                      {/* State C: Google Drive unconfigured on server */}
                      {!driveStatusError && driveStatus && !driveStatus.configured && (
                        <div className="p-4 rounded-xl bg-surface-2/60 border border-glass-border/40 flex flex-col gap-2">
                          <div className="text-xs font-bold text-ink flex items-center gap-1.5">
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></svg>
                            Server OAuth Unavailable
                          </div>
                          <p className="text-xs text-ink-dim leading-relaxed">
                            Google Drive cloud storage is temporarily unavailable because Google Drive OAuth credentials are not configured on this server.
                          </p>
                          <p className="text-[11px] text-ink-dim">
                            All your chat attachments will continue to be safely stored using Pookie Chat managed encrypted storage.
                          </p>
                        </div>
                      )}

                      {/* State A: Connected */}
                      {!driveStatusError && driveStatus?.configured && driveStatus?.connected && (
                        <div className="flex flex-col gap-3 rounded-xl bg-surface-2/40 p-4 border border-glass-border/40">
                          <div className="flex items-center gap-2 text-xs font-bold text-positive">
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                            Connected to your Google Drive
                          </div>
                          <p className="text-xs text-ink-dim leading-relaxed">
                            Attachments are saved as end-to-end encrypted blobs in your personal Google Drive folder. Pookie Chat cannot read your attachments.
                          </p>
                          {driveStatus.folderUrl && (
                            <a
                              href={driveStatus.folderUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="text-xs text-info hover:underline font-semibold flex items-center gap-1"
                            >
                              <span>Open Google Drive Folder</span>
                              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
                            </a>
                          )}
                          <Button
                            variant="raised"
                            accent="danger"
                            className="mt-1 text-xs font-semibold self-start"
                            onClick={disconnectGoogleDrive}
                            disabled={disconnectingDrive}
                          >
                            {disconnectingDrive ? 'Disconnecting…' : 'Disconnect Google Drive'}
                          </Button>
                        </div>
                      )}

                      {/* State B: Available but Disconnected */}
                      {!driveStatusError && driveStatus?.configured && !driveStatus?.connected && (
                        <div className="flex flex-col gap-3 rounded-xl bg-surface-2/40 p-4 border border-glass-border/40">
                          <div>
                            <h3 className="text-xs font-bold text-ink">Connect your Google Drive</h3>
                            <p className="text-xs text-ink-dim mt-1 leading-relaxed">
                              Store end-to-end encrypted attachments directly in your personal cloud storage instead of Pookie Chat servers.
                            </p>
                          </div>

                          <div className="rounded-xl bg-surface-2/60 p-3 space-y-1.5 text-[11px] text-ink-dim border border-glass-border/30">
                            <div className="font-semibold text-ink">How it works:</div>
                            <ul className="list-disc list-inside space-y-1">
                              <li>Attachments are encrypted on your device before upload</li>
                              <li>Encrypted blobs are saved to a dedicated app folder in your Drive</li>
                              <li>Pookie Chat never receives plaintext file contents or private keys</li>
                              <li>You retain 100% control and ownership of your storage quota</li>
                            </ul>
                          </div>

                          <Button
                            variant="glass"
                            accent="info"
                            className="mt-1 text-xs font-bold w-full sm:w-auto self-start"
                            onClick={connectGoogleDrive}
                            disabled={connectingDrive}
                          >
                            {connectingDrive ? 'Connecting to Google…' : 'Connect Google Drive'}
                          </Button>
                        </div>
                      )}
                    </div>
                  </Section>
                </div>
              )}

              {/* SECTION: HELP & LEGAL */}
              {activeCategory === 'legal' && (
                <div className="flex flex-col gap-4">
                  <Section title="Help & Documentation">
                    <div className="flex flex-col divide-y divide-glass-border/30">
                      <Link href="/privacy" className="py-2.5 text-xs font-semibold text-info hover:underline flex items-center justify-between">
                        <span>Privacy Policy</span>
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="9 18 15 12 9 6" />
                        </svg>
                      </Link>
                      <Link href="/terms" className="py-2.5 text-xs font-semibold text-info hover:underline flex items-center justify-between">
                        <span>Terms of Service</span>
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="9 18 15 12 9 6" />
                        </svg>
                      </Link>
                      <Link href="/support" className="py-2.5 text-xs font-semibold text-info hover:underline flex items-center justify-between">
                        <span>Support & FAQ</span>
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="9 18 15 12 9 6" />
                        </svg>
                      </Link>
                      <a href={DEVELOPER_PORTAL_URL} target="_blank" rel="noreferrer" className="py-2.5 text-xs font-semibold text-info hover:underline flex items-center justify-between">
                        <span>Developer Portal</span>
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="9 18 15 12 9 6" />
                        </svg>
                      </a>
                    </div>
                  </Section>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>

      {/* MODAL 1: Disable App Lock Authentication Modal */}
      {showDisableModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-backdrop/75 backdrop-blur-sm">
          <NeoSurface variant="raised" className="max-w-md w-full p-6 flex flex-col gap-4 border border-glass-border/60 shadow-2xl">
            <div>
              <h2 className="text-lg font-bold text-ink">Disable App Lock?</h2>
              <p className="mt-1 text-xs text-ink-dim">
                Enter your current PIN to disable App Lock.
              </p>
            </div>

            <form onSubmit={handleDisableAppLockSubmit} className="flex flex-col gap-3">
              <NeoInput
                type="password"
                inputMode="numeric"
                placeholder="Current PIN"
                value={disablePin}
                onChange={(e) => setDisablePin(e.target.value)}
                autoFocus
              />

              {disableError && (
                <div role="alert" className="text-xs font-semibold text-danger flex items-center gap-1.5">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                  {disableError}
                </div>
              )}

              <div className="flex gap-2.5 pt-2">
                <Button
                  type="button"
                  variant="ghost"
                  className="flex-1 font-semibold text-xs"
                  onClick={() => setShowDisableModal(false)}
                  disabled={disabling}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="raised"
                  accent="danger"
                  className="flex-1 font-semibold text-xs"
                  disabled={disabling || !disablePin}
                >
                  {disabling ? 'Disabling…' : 'Confirm / Disable'}
                </Button>
              </div>
            </form>
          </NeoSurface>
        </div>
      )}

      {/* MODAL 2: Change App Lock PIN Modal */}
      {showChangePinModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-backdrop/75 backdrop-blur-sm">
          <NeoSurface variant="raised" className="max-w-md w-full p-6 flex flex-col gap-4 border border-glass-border/60 shadow-2xl">
            <div>
              <h2 className="text-lg font-bold text-ink">Change App Lock PIN</h2>
              <p className="mt-1 text-xs text-ink-dim">
                Enter your current PIN, then choose a new 4+ digit PIN.
              </p>
            </div>

            <form onSubmit={handleChangePinSubmit} className="flex flex-col gap-3">
              <NeoInput
                type="password"
                inputMode="numeric"
                placeholder="Current PIN"
                value={changeOldPin}
                onChange={(e) => setChangeOldPin(e.target.value)}
                autoFocus
              />
              <NeoInput
                type="password"
                inputMode="numeric"
                placeholder="New PIN (4+ digits)"
                value={changeNewPin}
                onChange={(e) => setChangeNewPin(e.target.value)}
              />
              <NeoInput
                type="password"
                inputMode="numeric"
                placeholder="Confirm New PIN"
                value={changeConfirmPin}
                onChange={(e) => setChangeConfirmPin(e.target.value)}
              />

              {changePinError && (
                <div role="alert" className="text-xs font-semibold text-danger flex items-center gap-1.5">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                  {changePinError}
                </div>
              )}

              <div className="flex gap-2.5 pt-2">
                <Button
                  type="button"
                  variant="ghost"
                  className="flex-1 font-semibold text-xs"
                  onClick={() => setShowChangePinModal(false)}
                  disabled={changingPin}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="raised"
                  className="flex-1 font-semibold text-xs"
                  disabled={changingPin || !changeOldPin || !changeNewPin || !changeConfirmPin}
                >
                  {changingPin ? 'Updating PIN…' : 'Save PIN'}
                </Button>
              </div>
            </form>
          </NeoSurface>
        </div>
      )}

      {/* MODAL 3: Logout Confirmation Modal */}
      {showLogoutConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-backdrop/75 backdrop-blur-sm animate-in fade-in duration-200">
          <NeoSurface variant="raised" className="max-w-sm w-full p-6 flex flex-col gap-4 border border-glass-border/60 shadow-2xl">
            <div>
              <h2 className="text-lg font-bold text-ink">Log out of Pookie Chat?</h2>
              <p className="mt-1 text-xs text-ink-dim leading-relaxed">
                Your current active session on this device will be logged out and revoked. You will need your password or Google account to sign back in.
              </p>
            </div>
            <div className="flex gap-2.5 pt-2">
              <Button
                variant="raised"
                className="flex-1 font-semibold text-xs"
                onClick={() => setShowLogoutConfirm(false)}
              >
                Cancel
              </Button>
              <Button
                variant="raised"
                accent="danger"
                className="flex-1 font-semibold text-xs"
                onClick={() => logout()}
              >
                Log Out
              </Button>
            </div>
          </NeoSurface>
        </div>
      )}

      {/* Persistent Bottom TabBar on Mobile */}
      <TabBar active="Settings" />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <NeoSurface variant="raised" className="p-4 sm:p-5 rounded-2xl flex flex-col gap-3">
      <div className="text-xs font-bold uppercase tracking-wider text-ink-dim/80">{title}</div>
      {children}
    </NeoSurface>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm font-semibold text-ink">{label}</span>
      <button
        type="button"
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
