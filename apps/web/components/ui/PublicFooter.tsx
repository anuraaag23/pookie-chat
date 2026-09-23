import Link from 'next/link';

interface PublicFooterProps {
  className?: string;
}

export function PublicFooter({ className = '' }: PublicFooterProps) {
  const year = new Date().getFullYear();

  return (
    <footer
      role="contentinfo"
      aria-label="Legal and support links"
      className={`w-full py-6 text-center text-xs text-ink-dim ${className}`}
    >
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
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
      <div className="mt-2 text-[11px] opacity-70">
        &copy; {year} Pookie Chat. End-to-end encrypted messaging.
      </div>
    </footer>
  );
}
