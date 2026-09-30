import { PookieLogo } from '@/components/ui/PookieLogo';

export default function Loading() {
  // Non-disruptive loading placeholder to prevent full-screen flashing during client-side tab navigation
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none opacity-0 transition-opacity duration-200">
      <PookieLogo size="md" className="opacity-0" priority />
    </div>
  );
}
