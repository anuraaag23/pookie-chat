'use client';

import { useOnlineStatus } from '@/lib/offline/useOnlineStatus';

export function OfflineBanner() {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed top-0 left-0 right-0 z-50 flex items-center justify-center gap-2 bg-surface-2/95 border-b border-glass-border px-4 py-2 text-xs text-ink-dim shadow-sm backdrop-blur-md"
    >
      <svg
        className="h-3.5 w-3.5 text-warning shrink-0"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <line x1="1" y1="1" x2="23" y2="23" />
        <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
        <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
        <line x1="12" y1="20" x2="12.01" y2="20" />
      </svg>
      <span>You are offline. Reconnecting when connection returns…</span>
    </div>
  );
}
