'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/lib/auth/AuthContext';
import { Button } from '@/components/ui/Button';
import { NeoSurface } from '@/components/ui/NeoSurface';
import { PublicFooter } from '@/components/ui/PublicFooter';
import { ThemeToggle } from '@/components/ui/ThemeToggle';

export default function Home() {
  const { userId, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && userId) {
      router.replace('/chat');
    }
  }, [loading, userId, router]);

  if (loading) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col items-center justify-center p-6 text-ink">
        <div className="text-xs text-ink-dim">Loading…</div>
      </main>
    );
  }

  if (userId) {
    return null;
  }

  return (
    <main className="relative mx-auto flex min-h-screen max-w-sm sm:max-w-md flex-col items-center justify-between p-6 text-ink">
      <div className="absolute top-4 right-4 sm:top-6 sm:right-6">
        <ThemeToggle />
      </div>
      <div className="w-full flex-1 flex flex-col items-center justify-center gap-6 my-auto">
        <div className="text-center">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-surface neo-raised">
            <svg className="h-7 w-7 text-info" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Pookie Chat</h1>
          <p className="mt-1.5 text-xs text-ink-dim">
            Private, end-to-end encrypted messaging.
          </p>
        </div>

        <NeoSurface variant="raised" className="w-full p-6 flex flex-col gap-3">
          <Link href="/register" className="w-full">
            <Button variant="raised" accent="info" className="w-full">
              Create an account
            </Button>
          </Link>
          <Link href="/login" className="w-full">
            <Button variant="ghost" className="w-full text-xs">
              Sign in
            </Button>
          </Link>
        </NeoSurface>
      </div>

      <PublicFooter className="mt-auto" />
    </main>
  );
}

