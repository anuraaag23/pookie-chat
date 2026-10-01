'use client';

import { useEffect, useRef, useState, ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { NeoInput } from '@/components/ui/NeoInput';
import { NeoSurface } from '@/components/ui/NeoSurface';
import { PookieLogo } from '@/components/ui/PookieLogo';
import { isProtectedRoute } from '@/lib/auth/routeGuards';
import { useAuth } from '@/lib/auth/AuthContext';
import { AppLockStateMachine, AppLockState } from './lifecycle';
import {
  setActiveAppLockUser,
  hasAppLockVerifier,
  setAppLockVerifier,
  setAppLocked,
  recordActivity,
} from './state';
import { hashLocalSecret } from '../localauth/localSecret';

export function AppLockGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { userId, logout } = useAuth();
  const isProtected = isProtectedRoute(pathname);

  const [state, setState] = useState<AppLockState>('disabled');
  const [checked, setChecked] = useState(false);
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // When App Lock is enabled on account but local verifier is missing on this device
  const [hasVerifier, setHasVerifier] = useState<boolean | null>(null);
  const [setupPin, setSetupPin] = useState('');
  const [setupConfirmPin, setSetupConfirmPin] = useState('');
  const [setupError, setSetupError] = useState<string | null>(null);

  const lastEvaluatedKeyRef = useRef<string | null>(null);

  const machineRef = useRef<AppLockStateMachine | null>(null);
  if (!machineRef.current) {
    machineRef.current = new AppLockStateMachine({
      onStateChange: (s) => setState(s),
    });
  }

  // Update active user and re-evaluate lock state when userId or route changes
  useEffect(() => {
    setActiveAppLockUser(userId);
    const evalKey = `${userId || 'anon'}:${isProtected ? 'protected' : 'public'}`;
    if (lastEvaluatedKeyRef.current !== evalKey && isProtected) {
      setChecked(false);
    }
    machineRef.current?.init(isProtected, userId).then((s) => {
      lastEvaluatedKeyRef.current = evalKey;
      setState(s);
      setChecked(true);
    });
  }, [userId, isProtected]);

  // Check if current device has local verifier when locked
  useEffect(() => {
    if (state === 'locked' && userId) {
      hasAppLockVerifier(userId)
        .then((hasV) => setHasVerifier(hasV))
        .catch(() => setHasVerifier(true));
    } else {
      setHasVerifier(null);
    }
  }, [state, userId]);

  // Lifecycle listeners
  useEffect(() => {
    if (!isProtected || !userId) {
      setState('disabled');
      setChecked(true);
      return;
    }

    const machine = machineRef.current!;

    function onVisibilityChange() {
      if (document.visibilityState === 'hidden') {
        machine.handleDeparture('hidden');
      } else if (document.visibilityState === 'visible') {
        machine.handleReturn('visible');
      }
    }

    function onWindowBlur() {
      machine.handleDeparture('blur');
    }

    function onWindowFocus() {
      machine.handleReturn('focus');
    }

    function onPageHide() {
      machine.handleDeparture('pagehide');
    }

    function onPageShow() {
      machine.handleReturn('pageshow');
    }

    function onImmediateLock() {
      machine.lockNow();
    }

    function onStorage(e: StorageEvent) {
      if (e.key === 'applock:lock-event') {
        machine.lockNow();
      }
    }

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('blur', onWindowBlur);
    window.addEventListener('focus', onWindowFocus);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('applock:lock', onImmediateLock);
    window.addEventListener('storage', onStorage);

    // Inactivity interval (1s polling when visible)
    const intervalTimer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        machine.checkInactivity();
      }
    }, 1000);

    // Any user interaction resets inactivity (debounced)
    let activityThrottled = false;
    function onActivity() {
      if (activityThrottled) return;
      activityThrottled = true;
      machine.handleUserActivity();
      setTimeout(() => {
        activityThrottled = false;
      }, 1000);
    }

    window.addEventListener('pointerdown', onActivity);
    window.addEventListener('keydown', onActivity);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('blur', onWindowBlur);
      window.removeEventListener('focus', onWindowFocus);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('applock:lock', onImmediateLock);
      window.removeEventListener('storage', onStorage);
      clearInterval(intervalTimer);
      window.removeEventListener('pointerdown', onActivity);
      window.removeEventListener('keydown', onActivity);
    };
  }, [isProtected, userId]);

  async function attemptUnlock() {
    if (!pin.trim() || submitting) return;
    setSubmitting(true);
    setError(false);
    try {
      const ok = await machineRef.current!.attemptUnlock(pin.trim());
      if (ok) {
        setPin('');
      } else {
        setError(true);
        setPin('');
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSetupDevicePin(e: React.FormEvent) {
    e.preventDefault();
    setSetupError(null);
    if (!setupPin || setupPin.length < 4) {
      setSetupError('PIN must be at least 4 digits.');
      return;
    }
    if (setupPin !== setupConfirmPin) {
      setSetupError('PINs do not match.');
      return;
    }
    if (!userId) return;

    setSubmitting(true);
    try {
      const verifier = await hashLocalSecret(setupPin);
      await setAppLockVerifier(verifier, userId);
      await setAppLocked(false, userId);
      await recordActivity(userId);
      setHasVerifier(true);
      setSetupPin('');
      setSetupConfirmPin('');
      setState('unlocked');
    } catch {
      setSetupError('Could not set device PIN. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  // Public routes or disabled state bypass the lock screen
  if (!isProtected) {
    return <>{children}</>;
  }

  const evalKey = `${userId || 'anon'}:protected`;
  const isCheckedForCurrentRoute = checked && lastEvaluatedKeyRef.current === evalKey;

  if (!isCheckedForCurrentRoute) return null; // Avoid a flash of unlocked content while the check runs

  if (state !== 'locked') return <>{children}</>;

  return (
    <main className="mx-auto flex min-h-screen max-w-sm sm:max-w-md flex-col items-center justify-center gap-5 p-6">
      <NeoSurface variant="raised" className="w-full p-6 text-center">
        <div className="flex justify-center mb-4">
          <PookieLogo size="sm" priority />
        </div>

        {hasVerifier === false ? (
          <form onSubmit={handleSetupDevicePin} className="flex flex-col gap-3">
            <h2 className="text-base font-bold text-ink">Set Device PIN</h2>
            <p className="text-xs text-ink-dim -mt-1">
              App Lock is enabled on your account. Create a 4+ digit PIN for this device to continue.
            </p>

            <NeoInput
              type="password"
              inputMode="numeric"
              autoFocus
              value={setupPin}
              onChange={(e) => setSetupPin(e.target.value)}
              placeholder="New PIN (min 4 digits)"
              className="text-center"
            />
            <NeoInput
              type="password"
              inputMode="numeric"
              value={setupConfirmPin}
              onChange={(e) => setSetupConfirmPin(e.target.value)}
              placeholder="Confirm PIN"
              className="text-center"
            />

            {setupError && <div className="text-xs font-semibold text-danger">{setupError}</div>}

            <Button
              type="submit"
              variant="glass"
              accent="info"
              className="w-full mt-2 font-bold"
              disabled={submitting || setupPin.length < 4 || !setupConfirmPin}
            >
              {submitting ? 'Setting PIN…' : 'Set PIN & Continue'}
            </Button>
          </form>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="text-sm font-semibold text-ink">Enter your PIN to continue</div>
            <NeoInput
              type="password"
              inputMode="numeric"
              autoFocus
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && attemptUnlock()}
              placeholder="PIN"
              className="text-center"
            />
            {error && <div className="text-sm text-danger">Incorrect PIN.</div>}
            <Button
              variant="glass"
              accent="info"
              className="w-full font-bold"
              onClick={attemptUnlock}
              disabled={submitting || !pin.trim()}
            >
              {submitting ? 'Checking…' : 'Unlock'}
            </Button>
          </div>
        )}

        <div className="pt-4 border-t border-glass-border/30 mt-4">
          <button
            type="button"
            onClick={() => logout()}
            className="text-xs text-ink-dim hover:text-ink transition-colors underline"
          >
            Sign out of account
          </button>
        </div>
      </NeoSurface>
    </main>
  );
}

