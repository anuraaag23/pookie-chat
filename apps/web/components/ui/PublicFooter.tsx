import Link from 'next/link';

interface PublicFooterProps {
  className?: string;
  compact?: boolean;
}

export function PublicFooter({ className = '', compact = false }: PublicFooterProps) {
  const year = new Date().getFullYear();

  return (
    <footer
      role="contentinfo"
      aria-label="Legal and support links"
      className={`w-full ${compact ? 'py-1 sm:py-2' : 'py-6'} text-center text-xs text-ink-dim ${className}`}
    >
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5">
        <Link
          href="/privacy"
          className="transition-colors hover:text-ink hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-info focus-visible:outline-offset-2"
        >
          Privacy Policy
        </Link>
        <span className="opacity-40" aria-hidden="true">•</span>
        <Link
          href="/terms"
          className="transition-colors hover:text-ink hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-info focus-visible:outline-offset-2"
        >
          Terms of Service
        </Link>
        <span className="opacity-40" aria-hidden="true">•</span>
        <Link
          href="/support"
          className="transition-colors hover:text-ink hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-info focus-visible:outline-offset-2"
        >
          Support
        </Link>
      </div>
      <div className={`${compact ? 'mt-1 text-[10px]' : 'mt-2 text-[11px]'} opacity-70`}>
        &copy; {year} Pookie Chat. End-to-end encrypted messaging.
      </div>
    </footer>
  );
}
