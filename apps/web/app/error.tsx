'use client';

import { useEffect } from 'react';
import { ThemedErrorState } from '@/components/ui/ThemedErrorState';
import { getSafeErrorInfo } from '@/lib/errors/safeErrors';

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Only log error digest/metadata in development, never leaking stack traces or sensitive state to users
    if (process.env.NODE_ENV !== 'production') {
      console.error('Route error caught by error boundary:', error.digest || error.message);
    }
  }, [error]);

  const safeInfo = getSafeErrorInfo(error);

  return (
    <ThemedErrorState
      category={safeInfo.category}
      title={safeInfo.title}
      message={safeInfo.message}
      onRetry={reset}
      secondaryAction={{ label: 'Go Home', href: '/chat' }}
    />
  );
}
