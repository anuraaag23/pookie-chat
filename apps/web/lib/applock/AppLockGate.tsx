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
import { setActiveAppLockUser } from './state';

export function AppLockGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { userId } = useAuth();
  const isProtected = isProtectedRoute(pathname);

  const [state, setState] = useState<AppLockState>('disabled');
  const [checked, setChecked] = useState(false);
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const machineRef = useRef<AppLockStateMachine | null>(null);
  if (!machineRef.current) {
    machineRef.current = new AppLockStateMachine({
      onStateChange: (s) => setState(s),
    });
  }

  // Update active user and re-evaluate lock state when userId or route changes
  useEffect(() => {
    setActiveAppLockUser(userId);
    machineRef.current?.init(isProtected, userId).then((s) => {
      setState(s);
      setChecked(true);
    });
  }, [userId, isProtected]);

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

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('blur', onWindowBlur);
    window.addEventListener('focus', onWindowFocus);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);

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

  // Public routes or disabled state bypass the lock screen
  if (!isProtected) {
    return <>{children}</>;
  }

  if (!checked) return null; // Avoid a flash of unlocked content while the check runs

  if (state !== 'locked') return <>{children}</>;

  return (
    <main className="mx-auto flex min-h-screen max-w-sm sm:max-w-md flex-col items-center justify-center gap-5 p-6">
      <NeoSurface variant="raised" className="w-full p-6 text-center">
        <div className="flex justify-center mb-4">
          <PookieLogo size="sm" priority />
        </div>
        <div className="mb-4 text-center text-sm font-semibold text-ink">Enter your PIN to continue</div>
        <NeoInput
          type="password"
          inputMode="numeric"
          autoFocus
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && attemptUnlock()}
          placeholder="PIN"
          className="mb-3 text-center"
        />
        {error && <div className="mb-3 text-center text-sm text-danger">Incorrect PIN.</div>}
        <Button variant="glass" accent="info" className="w-full" onClick={attemptUnlock} disabled={submitting}>
          {submitting ? 'Checking…' : 'Unlock'}
        </Button>
      </NeoSurface>
    </main>
  );
}

