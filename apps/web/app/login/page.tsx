'use client';

import { useEffect, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { NeoInput } from '@/components/ui/NeoInput';
import { NeoSurface } from '@/components/ui/NeoSurface';
import { PublicFooter } from '@/components/ui/PublicFooter';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { PookieLogo } from '@/components/ui/PookieLogo';
import { useAuth } from '@/lib/auth/AuthContext';
import { api, ApiError } from '@/lib/api/client';
import { getSafeNextUrl } from '@/lib/auth/routeGuards';

function LoginForm() {
  const { login, loginWithGoogle, verifyEmail, resendVerification, userId, loading } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawNext = searchParams.get('next');
  const safeTarget = getSafeNextUrl(rawNext, '/chat');
  const googleTicket = searchParams.get('google_ticket');
  const googleError = searchParams.get('google_error');

  useEffect(() => {
    if (!loading && userId) {
      router.replace(safeTarget);
    }
  }, [loading, userId, router, safeTarget]);

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (googleError) {
      setError(decodeURIComponent(googleError));
    }
  }, [googleError]);

  useEffect(() => {
    if (googleTicket) {
      setSubmitting(true);
      loginWithGoogle(googleTicket)
        .then(() => {
          router.replace(safeTarget);
        })
        .catch((err) => {
          setError(err instanceof ApiError ? err.message : 'Google authentication failed.');
          setSubmitting(false);
        });
    }
  }, [googleTicket, loginWithGoogle, router, safeTarget]);

  async function handleGoogleAuth() {
    setError(null);
    try {
      const res = await api<{ authUrl?: string }>(
        `/api/auth/google/url?action=login&returnTo=${encodeURIComponent(safeTarget)}`,
        { authenticated: false },
      );
      if (res.authUrl) {
        window.location.href = res.authUrl;
      } else {
        setError('Google sign-in is not configured in this environment.');
      }
    } catch (err: any) {
      setError(err instanceof ApiError ? err.message : 'Google sign-in is not configured in this environment.');
    }
  }

  // Email verification prompt
  const [showVerifyInline, setShowVerifyInline] = useState(false);
  const [verifyCode, setVerifyCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [verifySuccess, setVerifySuccess] = useState<string | null>(null);

  const isEmailUnverified = error === 'Please verify your email before signing in.';

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setVerifySuccess(null);
    setSubmitting(true);
    try {
      await login(identifier.trim(), password, 'Web browser');
      router.push(safeTarget);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Something went wrong. Please try again.';
      setError(msg);
      if (msg === 'Please verify your email before signing in.') {
        setShowVerifyInline(true);
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!verifyCode.trim()) return;
    setVerifying(true);
    setError(null);
    try {
      await verifyEmail(identifier.trim(), verifyCode.trim());
      setVerifySuccess('Email successfully verified! Signing in…');
      setShowVerifyInline(false);
      // Attempt login with existing credentials if password is provided
      if (password) {
        await login(identifier.trim(), password, 'Web browser');
        router.push(safeTarget);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Invalid or expired verification code.');
    } finally {
      setVerifying(false);
    }
  }

  async function handleResend() {
    setResending(true);
    setError(null);
    try {
      await resendVerification(identifier.trim());
      setVerifySuccess('A new verification code has been sent to your email.');
      setTimeout(() => setVerifySuccess(null), 4000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not resend code. Please wait a moment.');
    } finally {
      setResending(false);
    }
  }

  return (
    <div className="relative flex h-[100dvh] max-h-[100dvh] w-full flex-col justify-between overflow-hidden px-4 py-2 sm:px-6 sm:py-3 select-none-safe">
      {/* Top Bar with Theme Toggle */}
      <header className="flex w-full items-center justify-end max-w-sm sm:max-w-md mx-auto shrink-0 pt-1">
        <ThemeToggle />
      </header>

      {/* Centered Main Form Container */}
      <main className="mx-auto flex w-full max-w-sm sm:max-w-md flex-1 flex-col justify-center gap-2 sm:gap-3 py-1 my-auto">
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <PookieLogo size="xs" priority />
            <span className="text-xs font-bold tracking-tight text-ink-dim uppercase">Pookie Chat</span>
          </div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-ink">Sign in</h1>
          <p className="mt-0.5 text-xs sm:text-sm text-ink-dim">Login with username or email</p>
        </div>

        <Button
          variant="ghost"
          type="button"
          onClick={handleGoogleAuth}
          disabled={submitting}
          className="w-full flex items-center justify-center gap-2 py-2 text-xs sm:text-sm"
          aria-label="Continue with Google"
        >
          <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
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

        <div className="relative flex items-center justify-center my-0.5 sm:my-1">
          <div className="w-full border-t border-glass-border"></div>
          <span className="absolute bg-surface px-3 text-xs text-ink-dim">or</span>
        </div>

        <form onSubmit={onSubmit} className="flex flex-col gap-2 sm:gap-2.5">
          <div>
            <label htmlFor="login-identifier" className="sr-only">
              Username or email
            </label>
            <NeoInput
              id="login-identifier"
              type="text"
              name="identifier"
              placeholder="Username or email"
              aria-label="Username or email"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              autoComplete="username"
              required
            />
          </div>

          <div className="relative">
            <label htmlFor="login-password" className="sr-only">
              Password
            </label>
            <NeoInput
              id="login-password"
              type={showPassword ? 'text' : 'password'}
              name="password"
              placeholder="Password"
              aria-label="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              className="pr-10"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute inset-y-0 right-2 my-auto flex h-7 w-7 items-center justify-center rounded text-ink-dim transition-colors hover:text-ink focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-info focus-visible:outline-offset-1"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              title={showPassword ? 'Hide password' : 'Show password'}
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

          {error && (
            <div role="alert" aria-live="polite" className="text-xs sm:text-sm text-danger font-medium">
              {error}
            </div>
          )}
          {verifySuccess && (
            <div role="status" aria-live="polite" className="text-xs sm:text-sm text-positive font-medium">
              {verifySuccess}
            </div>
          )}

          <div className="text-center text-[11px] leading-tight text-ink-dim">
            By continuing, you agree to the{' '}
            <Link
              href="/terms"
              className="text-info underline hover:text-info/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-info focus-visible:outline-offset-1 rounded-sm"
            >
              Terms of Service
            </Link>{' '}
            and acknowledge the{' '}
            <Link
              href="/privacy"
              className="text-info underline hover:text-info/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-info focus-visible:outline-offset-1 rounded-sm"
            >
              Privacy Policy
            </Link>
            .
          </div>

          <Button
            variant="raised"
            type="submit"
            disabled={submitting}
            className="w-full py-2.5 text-sm font-semibold"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        {/* Verification prompt when signing in with an unverified email */}
        {showVerifyInline && (
          <NeoSurface variant="raised" className="p-3 sm:p-4 flex flex-col gap-2 mt-1">
            <div className="text-xs font-semibold text-ink">Enter your verification code</div>
            <p className="text-[11px] sm:text-xs text-ink-dim">
              Enter the 6-digit code sent to your email to verify your address.
            </p>
            <div className="flex gap-2">
              <label htmlFor="login-verify-code" className="sr-only">
                6-digit verification code
              </label>
              <NeoInput
                id="login-verify-code"
                type="text"
                inputMode="numeric"
                maxLength={6}
                placeholder="123456"
                aria-label="6-digit verification code"
                value={verifyCode}
                onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, ''))}
                className="text-center font-mono tracking-widest text-sm flex-1"
              />
              <Button
                variant="raised"
                onClick={handleVerify}
                disabled={verifying || verifyCode.length < 6}
                className="!px-4 text-xs"
              >
                {verifying ? 'Verifying…' : 'Verify'}
              </Button>
            </div>
            <div className="flex justify-between items-center text-xs pt-1">
              <button
                type="button"
                onClick={handleResend}
                disabled={resending}
                className="text-info hover:underline text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-info focus-visible:outline-offset-1 rounded-sm"
              >
                {resending ? 'Sending…' : 'Resend code'}
              </button>
              <button
                type="button"
                onClick={() => setShowVerifyInline(false)}
                className="text-ink-dim hover:text-ink text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-info focus-visible:outline-offset-1 rounded-sm"
              >
                Dismiss
              </button>
            </div>
          </NeoSurface>
        )}

        <p className="text-center text-xs text-ink-dim">
          New here?{' '}
          <Link
            href="/register"
            className="text-info hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-info focus-visible:outline-offset-1 rounded-sm"
          >
            Create an account
          </Link>
        </p>
      </main>

      {/* Footer pinned at bottom */}
      <div className="w-full max-w-sm sm:max-w-md mx-auto shrink-0 pb-1">
        <PublicFooter compact />
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-[100dvh] max-h-[100dvh] w-full flex-col items-center justify-center p-6 overflow-hidden select-none-safe">
          <PookieLogo size="md" className="opacity-90 animate-pulse" priority />
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
