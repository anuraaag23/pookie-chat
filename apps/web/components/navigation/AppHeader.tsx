'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { Button } from '@/components/ui/Button';
import { PookieLogo } from '@/components/ui/PookieLogo';

interface AppHeaderProps {
  title?: string;
  activeTab?: 'Chat' | 'Connect' | 'Settings';
  showBack?: boolean;
  backHref?: string;
  onBack?: () => void;
  rightAction?: React.ReactNode;
  className?: string;
}

const NAV_ITEMS = [
  { label: 'Chat', href: '/chat' },
  { label: 'Connect', href: '/connect' },
  { label: 'Settings', href: '/settings' },
] as const;

export function AppHeader({
  title = 'Pookie Chat',
  activeTab,
  showBack = false,
  backHref,
  onBack,
  rightAction,
  className = '',
}: AppHeaderProps) {
  const pathname = usePathname();
  const router = useRouter();

  const handleBack = () => {
    if (onBack) {
      onBack();
    } else if (backHref) {
      router.push(backHref);
    } else if (typeof window !== 'undefined' && window.history.length > 1) {
      router.back();
    } else {
      router.push('/chat');
    }
  };

  return (
    <header
      className={`neo-raised sticky top-0 z-30 flex h-14 w-full shrink-0 items-center justify-between border-b border-glass-border/40 bg-surface px-3 sm:px-5 select-none-safe ${className}`}
    >
      {/* Left: Brand / Title / Optional Back */}
      <div className="flex items-center gap-2.5 min-w-0">
        {showBack && (
          <Button
            variant="ghost"
            size="icon"
            onClick={handleBack}
            className="!h-8 !w-8 shrink-0 md:hidden"
            aria-label="Back to conversations"
            title="Back to conversations"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </Button>
        )}
        <Link
          href="/chat"
          className="flex items-center gap-2.5 group focus-visible:outline focus-visible:outline-2 focus-visible:outline-info focus-visible:outline-offset-2 rounded-lg"
          aria-label="Pookie Chat"
        >
          <PookieLogo size="sm" className="!h-7 !w-7 sm:!h-8 sm:!w-8" priority />
          <span className="text-sm font-bold tracking-tight text-ink group-hover:text-info transition-colors truncate">
            {title}
          </span>
        </Link>
      </div>

      {/* Center: Desktop Navigation Tabs */}
      <nav
        aria-label="Main application"
        className="hidden md:flex items-center gap-1 neo-pressed rounded-xl p-1 bg-surface-2/40"
      >
        {NAV_ITEMS.map((item) => {
          const isActive = activeTab
            ? activeTab === item.label
            : pathname.startsWith(item.href);
          return (
            <Link
              key={item.label}
              href={item.href}
              className={`rounded-lg px-3.5 py-1.5 text-xs font-semibold transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-info focus-visible:outline-offset-1 ${
                isActive
                  ? 'neo-raised text-ink bg-surface shadow-sm'
                  : 'text-ink-dim hover:text-ink'
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Right: Actions + Global ThemeToggle */}
      <div className="flex items-center gap-2">
        {rightAction}
        <ThemeToggle />
      </div>
    </header>
  );
}
