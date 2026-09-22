'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { NeoInput } from '@/components/ui/NeoInput';
import { useAuth } from '@/lib/auth/AuthContext';
import { ApiError } from '@/lib/api/client';

export default function LoginPage() {
  const { login } = useAuth();
  const router = useRouter();
  const [accountId, setAccountId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(accountId.trim(), password, 'Web browser');
      router.push('/chat');
    } catch (e) {
      // Same generic message the backend returns — never "no such
      // account" vs "wrong password" (docs/01-THREAT-MODEL.md, enumeration).
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm sm:max-w-md flex-col justify-center gap-5 p-6">
      <div>
        <h1 className="text-xl font-bold">Sign in</h1>
        <p className="mt-1 text-sm text-ink-dim">Enter your account ID and password.</p>
      </div>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <NeoInput
          type="text"
          placeholder="Account ID"
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          autoComplete="username"
        />
        <NeoInput
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
        {error && <div className="text-sm text-danger">{error}</div>}
        <Button variant="raised" type="submit" disabled={submitting} className="w-full">
          {submitting ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
      <p className="text-center text-xs text-ink-dim">
        New here?{' '}
        <a href="/register" className="text-info">
          Create an account
        </a>
      </p>
    </main>
  );
}
