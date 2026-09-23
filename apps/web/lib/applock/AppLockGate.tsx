'use client';

import { useEffect, useRef, useState, ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { NeoInput } from '@/components/ui/NeoInput';
import { NeoSurface } from '@/components/ui/NeoSurface';
import { PookieLogo } from '@/components/ui/PookieLogo';
import { checkLocalSecret } from '@/lib/localauth/localSecret';
import { idbGet } from '@/lib/storage/localDb';
import { isProtectedRoute } from '@/lib/auth/routeGuards';
import {
  shouldBeLocked,
  recordActivity,
  setAppLocked,
  getAppLockTimeoutSeconds,
  isAppLockEnabled,
} from './state';

export function AppLockGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [checked, setChecked] = useState(false);
  const [locked, setLocked] = useState(false);
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);
  const activityTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isProtected = isProtectedRoute(pathname);

  async function evaluateLock(isContextBoundary = false): Promise<boolean> {
    if (!isProtected) {
      setLocked(false);
      setChecked(true);
      return false;
    }

    const enabled = await isAppLockEnabled();
    if (!enabled) {
      setLocked(false);
      setChecked(true);
      return false;
    }

    const shouldLock = await shouldBeLocked(isContextBoundary);
    setLocked(shouldLock);
    setChecked(true);
    return shouldLock;
  }

  useEffect(() => {
    // Initial mount check
    evaluateLock(true).then((wasLocked) => {
      if (!wasLocked) {
        recordActivity();
      }
    });

    async function onVisibilityChange() {
      if (document.visibilityState === 'hidden') {
        const timeout = await getAppLockTimeoutSeconds();
        if (timeout === 0) {
          await setAppLocked(true);
          setLocked(true);
        } else {
          await recordActivity();
        }
      } else if (document.visibilityState === 'visible') {
        await evaluateLock(true);
      }
    }

    async function onWindowBlur() {
      const timeout = await getAppLockTimeoutSeconds();
      if (timeout === 0) {
        await setAppLocked(true);
        setLocked(true);
      }
    }

    async function onWindowFocus() {
      await evaluateLock(true);
    }

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('blur', onWindowBlur);
    window.addEventListener('focus', onWindowFocus);

    // Active inactivity polling timer (1s interval)
    const intervalTimer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        evaluateLock(false);
      }
    }, 1000);

    // Any interaction while unlocked resets the inactivity clock (debounced)
    function onActivity() {
      if (activityTimer.current) return;
      activityTimer.current = setTimeout(() => {
        recordActivity();
        activityTimer.current = null;
      }, 1000);
    }

    window.addEventListener('pointerdown', onActivity);
    window.addEventListener('keydown', onActivity);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('blur', onWindowBlur);
      window.removeEventListener('focus', onWindowFocus);
      clearInterval(intervalTimer);
      window.removeEventListener('pointerdown', onActivity);
      window.removeEventListener('keydown', onActivity);
      if (activityTimer.current) {
        clearTimeout(activityTimer.current);
        activityTimer.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, isProtected]);

  async function attemptUnlock() {
    const verifier = await idbGet<string>('appLock:verifier');
    const ok = await checkLocalSecret(pin, verifier ?? null);
    if (ok) {
      await setAppLocked(false);
      setLocked(false);
      setError(false);
      setPin('');
      await recordActivity();
    } else {
      setError(true);
      setPin('');
    }
  }

  // Public routes or uninspected state bypass the lock screen
  if (!isProtected) {
    return <>{children}</>;
  }

  if (!checked) return null; // Avoid a flash of unlocked content while the check runs

  if (!locked) return <>{children}</>;

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
        <Button variant="glass" accent="info" className="w-full" onClick={attemptUnlock}>
          Unlock
        </Button>
      </NeoSurface>
    </main>
  );
}
