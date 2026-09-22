'use client';

import { useEffect, useRef, useState, ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { NeoInput } from '@/components/ui/NeoInput';
import { NeoSurface } from '@/components/ui/NeoSurface';
import { checkLocalSecret } from '@/lib/localauth/localSecret';
import { idbGet } from '@/lib/storage/localDb';
import { shouldBeLocked, recordActivity } from './state';

export function AppLockGate({ children }: { children: ReactNode }) {
  const [checked, setChecked] = useState(false);
  const [locked, setLocked] = useState(false);
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);
  const activityTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function evaluateLock() {
    const shouldLock = await shouldBeLocked();
    setLocked(shouldLock);
    setChecked(true);
  }

  useEffect(() => {
    evaluateLock();
    recordActivity();

    function onVisibilityChange() {
      if (document.visibilityState === 'visible') evaluateLock();
      else recordActivity(); // stamp the moment it was backgrounded, not when it's reopened
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    // Any interaction while unlocked resets the inactivity clock. Debounced
    // to one write per second so this isn't hammering IndexedDB on every
    // keystroke/mousemove.
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
      window.removeEventListener('pointerdown', onActivity);
      window.removeEventListener('keydown', onActivity);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function attemptUnlock() {
    const verifier = await idbGet<string>('appLock:verifier');
    const ok = await checkLocalSecret(pin, verifier ?? null);
    if (ok) {
      setLocked(false);
      setError(false);
      setPin('');
      await recordActivity();
    } else {
      setError(true);
      setPin('');
    }
  }

  if (!checked) return null; // avoid a flash of unlocked content while the check runs

  if (!locked) return <>{children}</>;

  return (
    <main className="mx-auto flex min-h-screen max-w-sm sm:max-w-md flex-col items-center justify-center gap-5 p-6">
      <NeoSurface variant="raised" className="w-full p-6">
        <div className="mb-4 text-center text-sm font-semibold">Enter your PIN to continue</div>
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
