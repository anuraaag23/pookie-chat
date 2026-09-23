'use client';

import { useEffect, ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth/AuthContext';
import { isProtectedRoute } from '@/lib/auth/routeGuards';
import { PookieLogo } from '@/components/ui/PookieLogo';

interface AuthGateProps {
  children: ReactNode;
}

/**
 * Centralized Client-Side Authorization Gate
 *
 * Enforces route authorization across all application transitions:
 * - Public routes (/, /login, /register, /privacy, /terms, /support) are rendered immediately.
 * - Authenticated routes (/chat, /chat/*, /connect, /settings, and future private routes)
 *   are gated: private children are NEVER rendered while loading or when unauthenticated.
 * - Unauthenticated visits redirect to /login?next=<encoded_path>.
 */
export function AuthGate({ children }: AuthGateProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { userId, loading } = useAuth();

  const isProtected = isProtectedRoute(pathname);

  useEffect(() => {
    if (isProtected && !loading && !userId) {
      const search = typeof window !== 'undefined' ? window.location.search : '';
      const fullTarget = pathname + search;
      router.replace(`/login?next=${encodeURIComponent(fullTarget)}`);
    }
  }, [isProtected, loading, userId, pathname, router]);

  // Public routes always render immediately
  if (!isProtected) {
    return <>{children}</>;
  }

  // While validating the session, render a branded loading state — NEVER render private content
  if (loading) {
    return (
      <div
        className="flex min-h-screen w-full flex-col items-center justify-center p-6 text-center select-none-safe"
        role="status"
        aria-live="polite"
        aria-label="Checking authorization"
      >
        <div className="flex flex-col items-center gap-3">
          <PookieLogo size="md" className="opacity-90 animate-pulse" priority />
          <span className="text-xs text-ink-dim tracking-wide font-medium">
            Checking authorization…
          </span>
        </div>
      </div>
    );
  }

  // If unauthenticated on a protected route, block children completely while redirect executes
  if (!userId) {
    return null;
  }

  // User is confirmed authenticated with a valid session
  return <>{children}</>;
}
