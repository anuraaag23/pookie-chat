import { PookieLogo } from '@/components/ui/PookieLogo';

export default function Loading() {
  return (
    <div
      className="flex min-h-[60vh] w-full flex-col items-center justify-center p-6 text-center select-none-safe"
      role="status"
      aria-live="polite"
      aria-label="Loading Pookie Chat"
    >
      <div className="flex flex-col items-center gap-3">
        <PookieLogo size="md" className="opacity-90 animate-pulse" priority />
        <span className="text-xs text-ink-dim tracking-wide font-medium">Loading…</span>
      </div>
    </div>
  );
}
