'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { NeoInput } from '@/components/ui/NeoInput';
import { NeoSurface } from '@/components/ui/NeoSurface';
import { PublicFooter } from '@/components/ui/PublicFooter';
import { useAuth } from '@/lib/auth/AuthContext';
import { api, ApiError } from '@/lib/api/client';
import { normalizeUsername, validateUsername } from '@/lib/username';

export default function RegisterPage() {
  const { register, userId, verifyEmail, resendVerification } = useAuth();
  const router = useRouter();

  const [step, setStep] = useState<'register' | 'verify'>('register');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [usernameInput, setUsernameInput] = useState('');
  const [emailInput, setEmailInput] = useState('');
  const [registeredEmail, setRegisteredEmail] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(60);
  const [resendSuccess, setResendSuccess] = useState(false);

  const [usernameAvailable, setUsernameAvailable] = useState<boolean | null>(null);
  const [checkingUsername, setCheckingUsername] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const normalizedUsername = normalizeUsername(usernameInput);
  const usernameValidation = validateUsername(normalizedUsername);

  const requestIdRef = useRef(0);
  useEffect(() => {
    setUsernameAvailable(null);
    if (!usernameValidation.valid) return;
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
        // Advisory only
      } finally {
        if (requestIdRef.current === thisRequestId) setCheckingUsername(false);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [normalizedUsername, usernameValidation.valid]);

  // Resend cooldown timer
  useEffect(() => {
    if (step !== 'verify' || resendCooldown <= 0) return;
    const timer = setInterval(() => {
      setResendCooldown((c) => (c > 0 ? c - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [step, resendCooldown]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!usernameValidation.valid) {
      setError(usernameValidation.error ?? 'Enter a valid username.');
      return;
    }
    if (!emailInput.trim()) {
      setError('Email address is required.');
      return;
    }
    if (password.length < 12) {
      setError('Use at least 12 characters — this protects your account since there is no phone recovery.');
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await register(password, normalizedUsername, 'Web browser', emailInput);
      if (res.emailVerificationRequired && (res.email || emailInput.trim())) {
        setRegisteredEmail(res.email || emailInput.trim());
        setStep('verify');
        setResendCooldown(60);
      } else {
        router.push('/chat');
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  async function onVerify(e: React.FormEvent) {
    e.preventDefault();
    const cleanCode = verificationCode.trim();
    if (!cleanCode) {
      setError('Please enter the 6-digit verification code.');
      return;
    }
    setError(null);
    setVerifying(true);
    try {
      await verifyEmail(registeredEmail, cleanCode);
      router.push('/chat');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Invalid or expired verification code.');
    } finally {
      setVerifying(false);
    }
  }

  async function onResend() {
    if (resendCooldown > 0 || resending) return;
    setError(null);
    setResending(true);
    setResendSuccess(false);
    try {
      await resendVerification(registeredEmail);
      setResendCooldown(60);
      setResendSuccess(true);
      setTimeout(() => setResendSuccess(false), 4000);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not resend code. Please try again later.');
    } finally {
      setResending(false);
    }
  }

  if (userId && step !== 'verify') {
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

  if (step === 'verify') {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm sm:max-w-md flex-col justify-center gap-5 p-6">
        <NeoSurface variant="raised" className="p-6">
          <div className="mb-4 text-center">
            <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-info/10 text-info">
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            </div>
            <h1 className="text-xl font-bold">Verify your email</h1>
            <p className="mt-1 text-xs text-ink-dim">
              We sent a 6-digit verification code to <span className="font-semibold text-ink">{registeredEmail}</span>. Enter it below to verify your email.
            </p>
          </div>

          <form onSubmit={onVerify} className="flex flex-col gap-4">
            <div>
              <NeoInput
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                placeholder="123456"
                value={verificationCode}
                onChange={(e) => setVerificationCode(e.target.value.replace(/\D/g, ''))}
                autoFocus
                autoComplete="one-time-code"
                className="text-center font-mono text-xl tracking-[0.5em]"
              />
              <div className="mt-1.5 text-center text-xs text-ink-dim">
                The code expires in 15 minutes.
              </div>
            </div>

            {error && <div className="text-center text-xs text-danger">{error}</div>}
            {resendSuccess && <div className="text-center text-xs text-positive">A new verification code has been sent!</div>}

            <Button variant="raised" type="submit" disabled={verifying || verificationCode.length < 6} className="w-full">
              {verifying ? 'Verifying…' : 'Verify email'}
            </Button>

            <div className="flex items-center justify-between pt-2 text-xs">
              <button
                type="button"
                onClick={onResend}
                disabled={resendCooldown > 0 || resending}
                className={`text-xs ${resendCooldown > 0 ? 'text-ink-dim cursor-not-allowed' : 'text-info hover:underline'}`}
              >
                {resending
                  ? 'Sending…'
                  : resendCooldown > 0
                    ? `Resend code in ${resendCooldown}s`
                    : 'Resend code'}
              </button>

              <button
                type="button"
                onClick={() => router.push('/chat')}
                className="text-ink-dim hover:text-ink hover:underline text-xs"
              >
                Skip for now
              </button>
            </div>
          </form>
        </NeoSurface>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm sm:max-w-md flex-col justify-center gap-5 p-6">
      <div>
        <h1 className="text-xl font-bold">Create your account</h1>
        <p className="mt-1 text-sm text-ink-dim">
          Choose a username and password to get started.
        </p>
      </div>

      <Button
        variant="ghost"
        type="button"
        onClick={() => setError('Google sign-up is not configured in this environment.')}
        className="w-full flex items-center justify-center gap-2"
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
          />
          <path
            fill="currentColor"
            d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
          />
          <path
            fill="currentColor"
            d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
          />
          <path
            fill="currentColor"
            d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
          />
        </svg>
        Continue with Google
      </Button>

      <div className="relative flex items-center justify-center my-1">
        <div className="w-full border-t border-glass-border"></div>
        <span className="absolute bg-surface-1 px-3 text-xs text-ink-dim">or</span>
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

        <div>
          <NeoInput
            type="email"
            placeholder="Email address"
            value={emailInput}
            onChange={(e) => setEmailInput(e.target.value)}
            autoComplete="email"
            spellCheck={false}
          />
          <div className="mt-1 text-xs text-ink-dim">
            Required. A 6-digit verification code will be sent to this address.
          </div>
        </div>

        <div className="relative">
          <NeoInput
            type={showPassword ? 'text' : 'password'}
            placeholder="Password (12+ characters)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            className="pr-10"
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            className="absolute inset-y-0 right-0 flex items-center pr-3 text-ink-dim hover:text-ink focus:outline-none"
            aria-label={showPassword ? 'Hide password' : 'Show password'}
          >
            {showPassword ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                <line x1="1" y1="1" x2="23" y2="23" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            )}
          </button>
        </div>
        <div className="relative">
          <NeoInput
            type={showConfirmPassword ? 'text' : 'password'}
            placeholder="Confirm password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            className="pr-10"
          />
          <button
            type="button"
            onClick={() => setShowConfirmPassword((v) => !v)}
            className="absolute inset-y-0 right-0 flex items-center pr-3 text-ink-dim hover:text-ink focus:outline-none"
            aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
          >
            {showConfirmPassword ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                <line x1="1" y1="1" x2="23" y2="23" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            )}
          </button>
        </div>
        {error && <div className="text-sm text-danger">{error}</div>}
        <div className="text-center text-[11px] leading-tight text-ink-dim">
          By continuing, you agree to the{' '}
          <Link href="/terms" className="text-info underline hover:text-info/80">
            Terms of Service
          </Link>{' '}
          and acknowledge the{' '}
          <Link href="/privacy" className="text-info underline hover:text-info/80">
            Privacy Policy
          </Link>
          .
        </div>
        <Button variant="raised" type="submit" disabled={submitting} className="w-full">
          {submitting ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
      <p className="text-center text-xs text-ink-dim">
        Already have an account?{' '}
        <Link href="/login" className="text-info hover:underline">
          Sign in
        </Link>
      </p>

      <PublicFooter className="mt-8" />
    </main>
  );
}
