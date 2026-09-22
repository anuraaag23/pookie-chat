'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { label: 'Chat', href: '/chat' },
  { label: 'Connect', href: '/connect' },
  { label: 'Settings', href: '/settings' },
] as const;

// Width reserved by the sidebar variant at lg+. Pages that render TabBar
// add a matching lg:pl-[SIDEBAR_WIDTH_CLASS] to their own <main> so
// content never sits underneath it — see e.g. app/chat/page.tsx.
export const SIDEBAR_WIDTH_CLASS = 'lg:w-56';

export function TabBar({ active }: { active?: string }) {
  const pathname = usePathname();
  return (
    // Below lg: the original fixed bottom pill bar, byte-for-byte the
    // same visual result as before this change (bottom-4 stays a plain
    // literal — only wrapped in max() for real devices with a home
    // indicator, never smaller than the existing 1rem gap on ones
    // without). At lg and up: the same nav, same Links, same
    // active-state class logic, laid out instead as a persistent
    // left sidebar — this is a CSS-only reflow of one shared
    // component, not a second nav implementation.
    <nav
      className={`neo-raised fixed inset-x-4 bottom-[max(1rem,env(safe-area-inset-bottom))] mx-auto flex max-w-md justify-around rounded-lg px-2 py-2.5
        lg:inset-x-auto lg:inset-y-0 lg:left-0 lg:right-auto lg:bottom-auto lg:top-0 lg:mx-0 lg:h-screen ${SIDEBAR_WIDTH_CLASS} lg:max-w-none
        lg:flex-col lg:items-stretch lg:justify-start lg:gap-1.5 lg:rounded-none lg:rounded-r-2xl lg:px-3 lg:py-6 lg:pt-[max(1.5rem,env(safe-area-inset-top))]`}
    >
      <div className="hidden px-2 pb-4 text-[15px] font-bold lg:block">Pookie Chat</div>
      {TABS.map((tab) => {
        const isActive = active ? tab.label === active : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.label}
            href={tab.href}
            className={`rounded-md px-2.5 py-1 text-[11.5px] font-semibold lg:w-full lg:px-3 lg:py-2.5 lg:text-left lg:text-[13.5px] ${isActive ? 'neo-pressed text-ink' : 'text-ink-dim'}`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
