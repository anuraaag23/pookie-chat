'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { NeoInput } from '@/components/ui/NeoInput';
import { NeoSurface } from '@/components/ui/NeoSurface';
import { useAuth } from '@/lib/auth/AuthContext';
import { api, ApiError } from '@/lib/api/client';
import { normalizeUsername, validateUsername } from '@/lib/username';

export default function RegisterPage() {
  const { register, userId } = useAuth();
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  // Raw field value — never includes "@"; the "@" shown next to the
  // input is presentation-only (see the input's own markup below) and
  // is never part of what gets typed, normalized, or sent to the API.
  const [usernameInput, setUsernameInput] = useState('');
  const [usernameAvailable, setUsernameAvailable] = useState<boolean | null>(null);
  const [checkingUsername, setCheckingUsername] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const normalizedUsername = normalizeUsername(usernameInput);
  const usernameValidation = validateUsername(normalizedUsername);

  // Debounced availability check. A monotonically increasing request id
  // (rather than just "am I still the latest effect") is what lets an
  // in-flight response from an earlier, now-stale keystroke be told
  // apart from the one that should actually update the UI, in case
  // responses ever arrive out of order — not just superseded, but
  // reordered.
  const requestIdRef = useRef(0);
  useEffect(() => {
    setUsernameAvailable(null);
    if (!usernameValidation.valid) return; // never fires a request for a locally-invalid value
    const thisRequestId = ++requestIdRef.current;
    setCheckingUsername(true);
    const timer = setTimeout(async () => {
      try {
        const result = await api<{ available: boolean }>(
          `/api/auth/username-availability?username=${encodeURIComponent(normalizedUsername)}`,
          { authenticated: false },
        );
        if (requestIdRef.current === thisRequestId) setUsernameAvailable(result.available);
      } catch {
        // Availability is advisory only — registration's own server-side
        // check remains authoritative (see AuthService.register), so a
        // failed/unreachable availability check must never itself block
        // submission. Leaving usernameAvailable as null (neither
        // confirmed taken nor confirmed free) does exactly that.
      } finally {
        if (requestIdRef.current === thisRequestId) setCheckingUsername(false);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [normalizedUsername, usernameValidation.valid]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!usernameValidation.valid) {
      setError(usernameValidation.error ?? 'Enter a valid username.');
      return;
    }
    if (password.length < 12) {
      setError('Use at least 12 characters — this protects your account since there is no email or phone recovery.');
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setSubmitting(true);
    try {
      await register(password, normalizedUsername, 'Web browser');
      router.push('/chat');
    } catch (e) {
      // The server's own uniqueness check is authoritative — this is
      // what actually catches a username taken by someone else between
      // the last availability check and this submit (or if the
      // availability check never succeeded at all).
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (userId) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm sm:max-w-md flex-col justify-center gap-4 p-6">
        <NeoSurface variant="raised" className="p-6 text-center">
          <div className="mb-2 text-sm font-semibold">You&apos;re already signed in</div>
          <div className="mb-1 text-xs text-ink-dim">Your account ID</div>
          <div className="mb-4 break-all rounded-lg bg-surface-2 p-3 font-mono text-xs">{userId}</div>
          <Button variant="raised" onClick={() => router.push('/chat')} className="w-full">
            Go to chat
          </Button>
        </NeoSurface>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm sm:max-w-md flex-col justify-center gap-5 p-6">
      <div>
        <h1 className="text-xl font-bold">Create your account</h1>
        <p className="mt-1 text-sm text-ink-dim">
          No email, no phone number. Just a password — you&apos;ll get a private account ID once you&apos;re set up.
        </p>
      </div>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <div>
          <div className="relative">
            <span className="pointer-events-none absolute inset-y-0 left-4 flex items-center text-sm text-ink-dim">@</span>
            <NeoInput
              type="text"
              placeholder="username"
              value={usernameInput}
              onChange={(e) => setUsernameInput(e.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              className="pl-8"
            />
          </div>
          {usernameInput.length > 0 && (
            <div className={`mt-1 text-xs ${!usernameValidation.valid ? 'text-danger' : usernameAvailable === false ? 'text-danger' : 'text-ink-dim'}`}>
              {!usernameValidation.valid
                ? usernameValidation.error
                : checkingUsername
                  ? 'Checking availability…'
                  : usernameAvailable === false
                    ? 'Username is already taken'
                    : usernameAvailable === true
                      ? 'Username is available'
                      : '\u00A0'}
            </div>
          )}
        </div>
        <NeoInput
          type="password"
          placeholder="Password (12+ characters)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
        />
        <NeoInput
          type="password"
          placeholder="Confirm password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
        />
        {error && <div className="text-sm text-danger">{error}</div>}
        <Button variant="raised" type="submit" disabled={submitting} className="w-full">
          {submitting ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
      <p className="text-center text-xs text-ink-dim">
        Already have an account?{' '}
        <a href="/login" className="text-info">
          Sign in
        </a>
      </p>
    </main>
  );
}
