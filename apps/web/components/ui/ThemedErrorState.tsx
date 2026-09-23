'use client';

import { useRouter } from 'next/navigation';
import { Button } from './Button';
import { NeoSurface } from './NeoSurface';
import { PookieLogo } from './PookieLogo';
import { ErrorCategory, getSafeErrorInfo } from '@/lib/errors/safeErrors';

export interface ThemedErrorAction {
  label: string;
  onClick?: () => void;
  href?: string;
}

export interface ThemedErrorStateProps {
  category?: ErrorCategory;
  error?: unknown;
  title?: string;
  message?: string;
  primaryAction?: ThemedErrorAction;
  secondaryAction?: ThemedErrorAction;
  onRetry?: () => void;
  compact?: boolean;
  className?: string;
}

function CategoryIcon({ category }: { category: ErrorCategory }) {
  switch (category) {
    case 'offline':
      return (
        <svg className="h-10 w-10 text-ink-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="1" y1="1" x2="23" y2="23" />
          <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
          <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
          <path d="M10.71 5.05A16 16 0 0 1 22.58 9" />
          <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
          <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
          <line x1="12" y1="20" x2="12.01" y2="20" />
        </svg>
      );
    case 'backend-unavailable':
      return (
        <svg className="h-10 w-10 text-info" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M22.61 16.95A5 5 0 0 0 18 10h-1.26a8 8 0 0 0-7.05-6M5 5a8 8 0 0 0-4 7h1a5 5 0 0 0 5 5h11" />
          <line x1="1" y1="1" x2="23" y2="23" />
        </svg>
      );
    case 'not-found':
      return (
        <svg className="h-10 w-10 text-ink-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
          <line x1="8" y1="11" x2="14" y2="11" />
        </svg>
      );
    case 'forbidden':
      return (
        <svg className="h-10 w-10 text-danger" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      );
    case 'unauthorized':
      return (
        <svg className="h-10 w-10 text-ink-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      );
    case 'rate-limited':
      return (
        <svg className="h-10 w-10 text-ink-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      );
    case 'server-error':
    case 'unknown':
    default:
      return (
        <svg className="h-10 w-10 text-danger" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      );
  }
}

export function ThemedErrorState({
  category: explicitCategory,
  error,
  title: explicitTitle,
  message: explicitMessage,
  primaryAction,
  secondaryAction,
  onRetry,
  compact = false,
  className = '',
}: ThemedErrorStateProps) {
  const router = useRouter();
  const safeFallback = getSafeErrorInfo(error);

  const category = explicitCategory ?? safeFallback.category;
  const title = explicitTitle ?? safeFallback.title;
  const message = explicitMessage ?? safeFallback.message;

  function handleAction(action?: ThemedErrorAction, defaultFallback?: () => void) {
    if (action?.onClick) {
      action.onClick();
    } else if (action?.href) {
      router.push(action.href);
    } else if (defaultFallback) {
      defaultFallback();
    }
  }

  // Default primary action if none provided
  const effectivePrimary: ThemedErrorAction = primaryAction ?? (
    onRetry
      ? { label: 'Try Again', onClick: onRetry }
      : safeFallback.actionType === 'home'
        ? { label: 'Go Home', href: '/chat' }
        : { label: 'Try Again', onClick: onRetry ?? (() => window.location.reload()) }
  );

  // Default secondary action if none provided
  const effectiveSecondary: ThemedErrorAction | undefined = secondaryAction ?? (
    safeFallback.actionType === 'back'
      ? { label: 'Go Back', onClick: () => window.history.back() }
      : effectivePrimary.label !== 'Go Home'
        ? { label: 'Go Home', href: '/chat' }
        : { label: 'Go Back', onClick: () => window.history.back() }
  );

  if (compact) {
    return (
      <NeoSurface
        variant="pressed"
        role="alert"
        aria-live="polite"
        className={`flex flex-col items-center gap-2 p-5 text-center ${className}`}
      >
        <CategoryIcon category={category} />
        <div className="text-sm font-semibold text-ink">{title}</div>
        <div className="text-xs text-ink-dim max-w-sm">{message}</div>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          <Button
            variant="raised"
            size="md"
            className="!px-3 !py-1.5 text-xs"
            onClick={() => handleAction(effectivePrimary)}
          >
            {effectivePrimary.label}
          </Button>
          {effectiveSecondary && (
            <Button
              variant="ghost"
              size="md"
              className="!px-3 !py-1.5 text-xs text-ink-dim"
              onClick={() => handleAction(effectiveSecondary)}
            >
              {effectiveSecondary.label}
            </Button>
          )}
        </div>
      </NeoSurface>
    );
  }

  return (
    <main
      role="alert"
      aria-labelledby="error-heading"
      className={`mx-auto flex min-h-screen max-w-sm sm:max-w-md flex-col items-center justify-center p-6 text-center ${className}`}
    >
      <div className="flex items-center gap-2 mb-4 opacity-75">
        <PookieLogo size="xs" />
        <span className="text-xs font-bold tracking-tight text-ink-dim uppercase">Pookie Chat</span>
      </div>
      <NeoSurface variant="raised" className="w-full flex flex-col items-center gap-4 p-8">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-surface-2">
          <CategoryIcon category={category} />
        </div>
        <div>
          <h1 id="error-heading" className="text-lg font-bold text-ink">
            {title}
          </h1>
          <p className="mt-2 text-sm text-ink-dim leading-relaxed">{message}</p>
        </div>
        <div className="mt-2 flex w-full flex-col gap-2.5">
          <Button
            variant="raised"
            className="w-full"
            onClick={() => handleAction(effectivePrimary)}
          >
            {effectivePrimary.label}
          </Button>
          {effectiveSecondary && (
            <Button
              variant="ghost"
              className="w-full text-ink-dim"
              onClick={() => handleAction(effectiveSecondary)}
            >
              {effectiveSecondary.label}
            </Button>
          )}
        </div>
      </NeoSurface>
    </main>
  );
}
