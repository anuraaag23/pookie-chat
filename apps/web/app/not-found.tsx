'use client';

import { ThemedErrorState } from '@/components/ui/ThemedErrorState';

export default function NotFound() {
  return (
    <ThemedErrorState
      category="not-found"
      title="Page Not Found"
      message="We couldn't find the page you're looking for."
      primaryAction={{ label: 'Go Home', href: '/chat' }}
      secondaryAction={{ label: 'Go Back', onClick: () => window.history.back() }}
    />
  );
}
