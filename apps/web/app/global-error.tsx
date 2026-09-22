'use client';

import './globals.css';
import { ThemedErrorState } from '@/components/ui/ThemedErrorState';
import { getSafeErrorInfo } from '@/lib/errors/safeErrors';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const safeInfo = getSafeErrorInfo(error);

  return (
    <html lang="en" data-theme="light">
      <body className="antialiased">
        <ThemedErrorState
          category={safeInfo.category}
          title={safeInfo.title}
          message={safeInfo.message}
          onRetry={reset}
          secondaryAction={{ label: 'Go Home', href: '/chat' }}
        />
      </body>
    </html>
  );
}
